// Bluetooth Classic RFCOMM (Serial Port Profile) access on macOS via IOBluetooth.
//
// The /dev/cu.* ports that macOS creates for paired SPP devices do not carry data for some devices
// (e.g. Kettler Racer S). Opening the RFCOMM channel directly via IOBluetooth works.
//
// IOBluetooth delivers its callbacks on the run loop of the thread that started the operation - in the
// Electron main process this is the main thread, whose run loop is always running. Plain Node.js does not
// run a CFRunLoop, therefore pump() is exported for scripts and tests.
//
// JS API:
//   list()                         -> [{ address, name, connected, channel }]  paired devices offering SPP
//   open(address, onEvent)         -> handle; events: {type:'open'|'data'|'close'|'error', data?, message?}
//   write(handle, buffer)          -> undefined (throws on error)
//   close(handle)                  -> undefined
//   pump(seconds)                  -> undefined, runs the current run loop (only needed outside Electron)

#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>
#include <node_api.h>
#include <map>
#include <string>
#include <vector>

#define NAPI_CALL(env, call)                                                   \
    do {                                                                       \
        if ((call) != napi_ok) {                                               \
            napi_throw_error((env), nullptr, "N-API call failed: " #call);     \
            return nullptr;                                                    \
        }                                                                      \
    } while (0)

static const uint16_t kSerialPortServiceUUID = 0x1101;

struct RfcommEvent {
    std::string type;
    std::vector<uint8_t> data;
    std::string message;
};

// ---- JS callback, invoked on the JS thread ------------------------------------
static void CallJs(napi_env env, napi_value jsCallback, void* /*context*/, void* rawEvent) {
    RfcommEvent* event = static_cast<RfcommEvent*>(rawEvent);
    if (env != nullptr && jsCallback != nullptr) {
        napi_value obj, type, undefined;
        napi_create_object(env, &obj);
        napi_create_string_utf8(env, event->type.c_str(), NAPI_AUTO_LENGTH, &type);
        napi_set_named_property(env, obj, "type", type);
        if (!event->data.empty()) {
            napi_value buffer;
            void* target = nullptr;
            napi_create_buffer_copy(env, event->data.size(), event->data.data(), &target, &buffer);
            napi_set_named_property(env, obj, "data", buffer);
        }
        if (!event->message.empty()) {
            napi_value message;
            napi_create_string_utf8(env, event->message.c_str(), NAPI_AUTO_LENGTH, &message);
            napi_set_named_property(env, obj, "message", message);
        }
        napi_get_undefined(env, &undefined);
        napi_call_function(env, undefined, jsCallback, 1, &obj, nullptr);
    }
    delete event;
}

static std::string ioReturnString(IOReturn status) {
    char buf[32];
    snprintf(buf, sizeof(buf), "IOReturn 0x%08x", status);
    return std::string(buf);
}

static BluetoothRFCOMMChannelID cachedSerialPortChannel(IOBluetoothDevice* device) {
    IOBluetoothSDPServiceRecord* record =
        [device getServiceRecordForUUID:[IOBluetoothSDPUUID uuid16:kSerialPortServiceUUID]];
    BluetoothRFCOMMChannelID channel = 0;
    if (record != nil && [record getRFCOMMChannelID:&channel] == kIOReturnSuccess)
        return channel;
    return 0;
}

// ---- one connection --------------------------------------------------------------
@interface RfcommConnection : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property (nonatomic, strong) IOBluetoothDevice* device;
@property (nonatomic, strong) IOBluetoothRFCOMMChannel* channel;
@property (nonatomic) napi_threadsafe_function tsfn;
@property (nonatomic) int32_t handle;
@property (nonatomic) BOOL isOpen;
@property (nonatomic) BOOL finished;
- (void)start;
- (void)closeConnection;
@end

// connections stay referenced here until they are finished: IOBluetooth does not retain its delegate
static std::map<int32_t, RfcommConnection*> connections;
static int32_t nextHandle = 1;

@implementation RfcommConnection

- (void)emit:(const std::string&)type message:(const std::string&)message {
    if (self.finished)
        return;
    RfcommEvent* event = new RfcommEvent{type, {}, message};
    napi_call_threadsafe_function(self.tsfn, event, napi_tsfn_nonblocking);
}

- (void)emitData:(const void*)data length:(size_t)length {
    if (self.finished)
        return;
    const uint8_t* bytes = static_cast<const uint8_t*>(data);
    RfcommEvent* event = new RfcommEvent{"data", std::vector<uint8_t>(bytes, bytes + length), ""};
    napi_call_threadsafe_function(self.tsfn, event, napi_tsfn_nonblocking);
}

// 'close' and 'error' end the connection; the threadsafe function is released afterwards
- (void)finish:(const std::string&)type message:(const std::string&)message {
    if (self.finished)
        return;
    [self emit:type message:message];
    self.finished = YES;
    self.isOpen = NO;
    napi_release_threadsafe_function(self.tsfn, napi_tsfn_release);
    // last strong reference - keep the object alive until this method returns
    RfcommConnection* keepAlive = self;
    connections.erase(self.handle);
    (void)keepAlive;
}

- (void)start {
    BluetoothRFCOMMChannelID channel = cachedSerialPortChannel(self.device);
    if (channel != 0) {
        [self openChannel:channel];
        return;
    }
    IOReturn status = [self.device performSDPQuery:self];
    if (status != kIOReturnSuccess)
        [self finish:"error" message:"SDP query failed: " + ioReturnString(status)];
}

- (void)sdpQueryComplete:(IOBluetoothDevice*)device status:(IOReturn)status {
    BluetoothRFCOMMChannelID channel = cachedSerialPortChannel(device);
    if (channel == 0) {
        [self finish:"error" message:"no Serial Port service found (" + ioReturnString(status) + ")"];
        return;
    }
    [self openChannel:channel];
}

- (void)openChannel:(BluetoothRFCOMMChannelID)channelID {
    IOBluetoothRFCOMMChannel* channel = nil;
    IOReturn status = [self.device openRFCOMMChannelAsync:&channel withChannelID:channelID delegate:self];
    if (status != kIOReturnSuccess) {
        [self finish:"error" message:"could not open RFCOMM channel: " + ioReturnString(status)];
        return;
    }
    self.channel = channel;
}

- (void)rfcommChannelOpenComplete:(IOBluetoothRFCOMMChannel*)rfcommChannel status:(IOReturn)error {
    if (error != kIOReturnSuccess) {
        // e.g. the device refuses the connection (a Kettler Racer S still in PC mode)
        [self finish:"error" message:"could not open RFCOMM channel: " + ioReturnString(error)];
        return;
    }
    self.channel = rfcommChannel;
    self.isOpen = YES;
    [self emit:"open" message:""];
}

- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel*)rfcommChannel data:(void*)dataPointer length:(size_t)dataLength {
    [self emitData:dataPointer length:dataLength];
}

- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel*)rfcommChannel {
    [self.device closeConnection];
    [self finish:"close" message:""];
}

- (IOReturn)sendBytes:(const uint8_t*)data length:(size_t)length {
    if (!self.isOpen || self.channel == nil)
        return kIOReturnNotOpen;
    size_t mtu = MAX((size_t)[self.channel getMTU], (size_t)1);
    size_t offset = 0;
    while (offset < length) {
        UInt16 chunk = (UInt16)MIN(mtu, length - offset);
        IOReturn status = [self.channel writeSync:(void*)(data + offset) length:chunk];
        if (status != kIOReturnSuccess)
            return status;
        offset += chunk;
    }
    return kIOReturnSuccess;
}

- (void)closeConnection {
    if (self.channel != nil)
        [self.channel closeChannel];
    [self.device closeConnection];
    // rfcommChannelClosed is not called if the channel never opened
    if (!self.isOpen)
        [self finish:"close" message:""];
}

@end

// ---- module functions ----------------------------------------------------------------
static RfcommConnection* getConnection(napi_env env, napi_value value) {
    int32_t handle = 0;
    if (napi_get_value_int32(env, value, &handle) != napi_ok)
        return nil;
    auto it = connections.find(handle);
    return it == connections.end() ? nil : it->second;
}

// list(): paired devices that offer the Serial Port service
static napi_value List(napi_env env, napi_callback_info info) {
    napi_value result;
    NAPI_CALL(env, napi_create_array(env, &result));
    uint32_t index = 0;
    @autoreleasepool {
        for (IOBluetoothDevice* device in [IOBluetoothDevice pairedDevices]) {
            BluetoothRFCOMMChannelID channel = cachedSerialPortChannel(device);
            if (channel == 0)
                continue;
            napi_value obj, address, name, connected, channelValue;
            NAPI_CALL(env, napi_create_object(env, &obj));
            NAPI_CALL(env, napi_create_string_utf8(env, [[device addressString] UTF8String] ?: "", NAPI_AUTO_LENGTH, &address));
            NAPI_CALL(env, napi_create_string_utf8(env, [[device name] UTF8String] ?: "", NAPI_AUTO_LENGTH, &name));
            NAPI_CALL(env, napi_get_boolean(env, [device isConnected], &connected));
            NAPI_CALL(env, napi_create_uint32(env, channel, &channelValue));
            napi_set_named_property(env, obj, "address", address);
            napi_set_named_property(env, obj, "name", name);
            napi_set_named_property(env, obj, "connected", connected);
            napi_set_named_property(env, obj, "channel", channelValue);
            NAPI_CALL(env, napi_set_element(env, result, index++, obj));
        }
    }
    return result;
}

// open(address, onEvent): handle
static napi_value Open(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc < 2) {
        napi_throw_type_error(env, nullptr, "open(address, onEvent) expected");
        return nullptr;
    }
    char address[64] = {0};
    size_t len = 0;
    NAPI_CALL(env, napi_get_value_string_utf8(env, args[0], address, sizeof(address), &len));

    IOBluetoothDevice* device = [IOBluetoothDevice deviceWithAddressString:[NSString stringWithUTF8String:address]];
    if (device == nil) {
        napi_throw_error(env, nullptr, "invalid Bluetooth address");
        return nullptr;
    }

    napi_value resourceName;
    NAPI_CALL(env, napi_create_string_utf8(env, "bt-rfcomm", NAPI_AUTO_LENGTH, &resourceName));
    napi_threadsafe_function tsfn;
    NAPI_CALL(env, napi_create_threadsafe_function(env, args[1], nullptr, resourceName, 0, 1,
                                                   nullptr, nullptr, nullptr, CallJs, &tsfn));

    RfcommConnection* connection = [[RfcommConnection alloc] init];
    connection.device = device;
    connection.tsfn = tsfn;
    int32_t handle = nextHandle++;
    connection.handle = handle;
    connections[handle] = connection;
    [connection start];

    napi_value result;
    NAPI_CALL(env, napi_create_int32(env, handle, &result));
    return result;
}

// write(handle, buffer)
static napi_value Write(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    RfcommConnection* connection = argc >= 2 ? getConnection(env, args[0]) : nil;
    if (connection == nil) {
        napi_throw_error(env, nullptr, "unknown handle");
        return nullptr;
    }
    void* data = nullptr;
    size_t length = 0;
    NAPI_CALL(env, napi_get_buffer_info(env, args[1], &data, &length));
    IOReturn status = [connection sendBytes:static_cast<const uint8_t*>(data) length:length];
    if (status != kIOReturnSuccess) {
        napi_throw_error(env, nullptr, ("write failed: " + ioReturnString(status)).c_str());
        return nullptr;
    }
    return nullptr;
}

// close(handle)
static napi_value Close(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    RfcommConnection* connection = argc >= 1 ? getConnection(env, args[0]) : nil;
    // removed from the map once the 'close' event has been emitted
    [connection closeConnection];
    return nullptr;
}

// pump(seconds): run the current run loop (plain Node.js only)
static napi_value Pump(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    double seconds = 0.01;
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc >= 1)
        napi_get_value_double(env, args[0], &seconds);
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, false);
    return nullptr;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        {"list", nullptr, List, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"pump", nullptr, Pump, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    };
    NAPI_CALL(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
