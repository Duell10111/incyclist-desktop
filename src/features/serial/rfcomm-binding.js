const { EventLogger } = require('gd-eventlog')

/**
 * Serial port binding for Bluetooth Classic devices on macOS that is based on a direct RFCOMM connection
 * (native addon incyclist-bt-rfcomm, IOBluetooth).
 *
 * The /dev/cu.* ports that macOS creates for paired Serial Port Profile devices do not carry any data for
 * some devices (e.g. Kettler Racer S), while an RFCOMM channel opened via IOBluetooth works.
 *
 * Ports are listed as `rfcomm:<bluetooth address>`. The binding follows @serialport/bindings-interface,
 * like the TCP binding in this folder.
 */

const PATH_PREFIX = 'rfcomm:'
const DEFAULT_OPEN_TIMEOUT = 15000
const CLOSE_TIMEOUT = 2000
// outside of Electron no CFRunLoop is running, IOBluetooth callbacks need to be pumped
const PUMP_INTERVAL = 10

function resolveNextTick() {
    return new Promise(resolve => process.nextTick(() => resolve()))
}

class CanceledError extends Error {
    constructor(message) {
        super(message)
        this.canceled = true
    }
}

function loadNative() {
    if (process.platform !== 'darwin')
        return null
    try {
        return require('incyclist-bt-rfcomm')
    }
    catch {
        return null
    }
}

class RunLoopPump {
    constructor(native) {
        this.native = native
        this.users = 0
        this.iv = null
    }

    acquire() {
        if (process.versions.electron)
            return
        this.users++
        if (!this.iv) {
            this.iv = setInterval(() => this.native.pump(0.001), PUMP_INTERVAL)
            // open ports keep the process alive via the native addon, not via this timer
            this.iv.unref?.()
        }
    }

    release() {
        if (process.versions.electron || this.users === 0)
            return
        this.users--
        if (this.users === 0 && this.iv) {
            clearInterval(this.iv)
            this.iv = null
        }
    }
}

class RfcommPortBinding {
    constructor(native, pump, options) {
        this.logger = new EventLogger('RfcommPort')
        this.native = native
        this.pump = pump
        this.openOptions = options
        this.handle = null
        this.opened = false
        this.closed = false
        this.data = Buffer.alloc(0)
        this.pendingRead = null
        this.closeWaiters = []
    }

    get isOpen() {
        return this.opened && !this.closed
    }

    connect(address, timeout) {
        return new Promise((resolve, reject) => {
            let settled = false
            const settle = (err) => {
                if (settled)
                    return
                settled = true
                clearTimeout(to)
                if (err)
                    reject(err)
                else
                    resolve(this)
            }

            const to = setTimeout(() => {
                settle(new Error('timeout'))
                this.close()
            }, timeout)

            this.pump.acquire()
            try {
                this.handle = this.native.open(address, (event) => {
                    this.onEvent(event)
                    if (event.type === 'open')
                        settle()
                    else if (event.type === 'error' || event.type === 'close')
                        settle(new Error(event.message || 'connection closed'))
                })
            }
            catch (err) {
                this.pump.release()
                settle(err)
            }
        })
    }

    onEvent(event) {
        switch (event.type) {
            case 'open':
                this.opened = true
                break
            case 'data':
                this.data = Buffer.concat([this.data, event.data])
                if (this.pendingRead) {
                    const pending = this.pendingRead
                    this.pendingRead = null
                    process.nextTick(pending)
                }
                break
            case 'error':
                this.logger.logEvent({ message: 'Port Error', path: this.openOptions.path, error: event.message })
                this.onClosed(new Error(event.message))
                break
            case 'close':
                this.onClosed(new CanceledError('port is closed'))
                break
        }
    }

    onClosed(err) {
        if (this.closed)
            return
        this.closed = true
        this.pump.release()
        if (this.pendingRead) {
            const pending = this.pendingRead
            this.pendingRead = null
            pending(err)
        }
        this.closeWaiters.forEach(done => done())
        this.closeWaiters = []
    }

    async close() {
        if (this.closed || this.handle === null)
            return
        this.data = Buffer.alloc(0)

        let timer
        const closed = new Promise(done => {
            this.closeWaiters.push(done)
            timer = setTimeout(done, CLOSE_TIMEOUT)
        })
        this.native.close(this.handle)
        await closed
        clearTimeout(timer)
        this.onClosed(new CanceledError('port is closed'))
    }

    async read(buffer, offset, length) {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        if (!Buffer.isBuffer(buffer)) {
            throw new TypeError('"buffer" is not a Buffer')
        }
        if (typeof offset !== 'number' || Number.isNaN(offset)) {
            throw new TypeError(`"offset" is not an integer got "${Number.isNaN(offset) ? 'NaN' : typeof offset}"`)
        }
        if (typeof length !== 'number' || Number.isNaN(length)) {
            throw new TypeError(`"length" is not an integer got "${Number.isNaN(length) ? 'NaN' : typeof length}"`)
        }
        if (buffer.length < offset + length) {
            throw new Error('buffer is too small')
        }

        await resolveNextTick()
        // the connection might have been closed in the meantime
        if (!this.isOpen && this.data.length === 0) {
            throw new CanceledError('port is closed')
        }

        if (this.data.length === 0) {
            return new Promise((resolve, reject) => {
                this.pendingRead = err => {
                    if (err)
                        return reject(err)
                    this.read(buffer, offset, length).then(resolve, reject)
                }
            })
        }

        const toCopy = this.data.subarray(0, length)
        const bytesRead = toCopy.copy(buffer, offset)
        this.data = this.data.subarray(bytesRead)
        return { buffer, bytesRead }
    }

    async write(buffer) {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        await resolveNextTick()
        this.native.write(this.handle, Buffer.from(buffer))
    }

    async update() {
        await resolveNextTick()
    }

    async set() {
        await resolveNextTick()
    }

    async get() {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        await resolveNextTick()
        return { cts: true, dsr: false, dcd: false }
    }

    async getBaudRate() {
        return { baudRate: this.openOptions.baudRate ?? 9600 }
    }

    async flush() {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        await resolveNextTick()
        this.data = Buffer.alloc(0)
    }

    async drain() {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        // writes are synchronous in the native addon
        await resolveNextTick()
    }
}

/**
 * Creates the RFCOMM binding, or returns null if the native addon is not available (e.g. not on macOS).
 * @param {object} [native] native addon - injectable for tests
 */
function createRfcommBinding(native = loadNative()) {
    if (!native)
        return null

    const pump = new RunLoopPump(native)

    return {
        async list() {
            return native.list().map(device => ({
                path: `${PATH_PREFIX}${device.address}`,
                manufacturer: device.name,
                serialNumber: device.address,
                locationId: undefined,
                pnpId: undefined,
                productId: undefined,
                vendorId: undefined
            }))
        },

        async open(options) {
            if (!options?.path?.startsWith(PATH_PREFIX))
                throw new TypeError('"path" is not valid')
            const address = options.path.substring(PATH_PREFIX.length)
            const port = new RfcommPortBinding(native, pump, options)
            return port.connect(address, options.timeout ?? DEFAULT_OPEN_TIMEOUT)
        }
    }
}

/**
 * Combines the regular serial binding with the RFCOMM binding: ports are listed from both,
 * `rfcomm:` paths are opened via RFCOMM, everything else via the regular binding.
 */
function combineWithRfcomm(serialBinding, rfcommBinding) {
    if (!rfcommBinding)
        return serialBinding

    return {
        async list(...args) {
            const [serialPorts, rfcommPorts] = await Promise.all([
                serialBinding.list(...args),
                rfcommBinding.list().catch(() => [])
            ])
            return [...serialPorts, ...rfcommPorts]
        },
        async open(options) {
            if (options?.path?.startsWith(PATH_PREFIX))
                return rfcommBinding.open(options)
            return serialBinding.open(options)
        }
    }
}

module.exports = { createRfcommBinding, combineWithRfcomm, RfcommPortBinding, PATH_PREFIX }
