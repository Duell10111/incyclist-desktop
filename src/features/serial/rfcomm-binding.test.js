const { createRfcommBinding, combineWithRfcomm } = require('./rfcomm-binding')

// fake of the native addon (incyclist-bt-rfcomm): events are delivered asynchronously, like the real addon
class FakeNative {
    constructor() {
        this.devices = [{ address: '00-80-25-42-40-be', name: 'RACER S 4240BE', connected: false, channel: 1 }]
        this.connections = new Map()
        this.nextHandle = 1
        this.written = []
        this.refuse = false
        this.pump = jest.fn()
    }

    list() {
        return this.devices
    }

    open(address, onEvent) {
        const handle = this.nextHandle++
        this.connections.set(handle, { address, onEvent })
        setTimeout(() => {
            if (this.refuse)
                onEvent({ type: 'error', message: 'could not open RFCOMM channel: IOReturn 0xe00002bc' })
            else
                onEvent({ type: 'open' })
        }, 5)
        return handle
    }

    write(handle, buffer) {
        this.written.push(buffer)
        // echo, as an answer of the device
        setTimeout(() => this.emit(handle, { type: 'data', data: Buffer.concat([buffer, Buffer.from('\r\n')]) }), 5)
    }

    close(handle) {
        setTimeout(() => this.emit(handle, { type: 'close' }), 5)
    }

    emit(handle, event) {
        this.connections.get(handle)?.onEvent(event)
    }
}

describe('RFCOMM binding', () => {
    let native, binding, ports

    beforeEach(() => {
        native = new FakeNative()
        binding = createRfcommBinding(native)
        ports = []
    })

    afterEach(async () => {
        for (const p of ports) {
            await p.close()
        }
    })

    const open = async (options = { path: 'rfcomm:00-80-25-42-40-be' }) => {
        const port = await binding.open(options)
        ports.push(port)
        return port
    }

    test('without native addon there is no binding', () => {
        expect(createRfcommBinding(null)).toBeNull()
    })

    test('list', async () => {
        expect(await binding.list()).toEqual([
            expect.objectContaining({ path: 'rfcomm:00-80-25-42-40-be', manufacturer: 'RACER S 4240BE', serialNumber: '00-80-25-42-40-be' })
        ])
    })

    test('open, write and read', async () => {
        const port = await open()
        expect(port.isOpen).toBe(true)

        await port.write(Buffer.from('ID'))
        expect(native.written).toEqual([Buffer.from('ID')])

        const { buffer, bytesRead } = await port.read(Buffer.alloc(64), 0, 64)
        expect(buffer.subarray(0, bytesRead).toString()).toBe('ID\r\n')
    })

    test('read returns at most length bytes and keeps the rest', async () => {
        const port = await open()
        await port.write(Buffer.from('ST'))
        await new Promise(done => setTimeout(done, 20))

        const first = await port.read(Buffer.alloc(2), 0, 2)
        const second = await port.read(Buffer.alloc(64), 0, 64)
        expect(first.buffer.subarray(0, first.bytesRead).toString()).toBe('ST')
        expect(second.buffer.subarray(0, second.bytesRead).toString()).toBe('\r\n')
    })

    test('device refuses the connection', async () => {
        native.refuse = true
        await expect(binding.open({ path: 'rfcomm:00-80-25-42-40-be' })).rejects.toThrow('0xe00002bc')
    })

    test('open timeout', async () => {
        native.open = (address, onEvent) => {
            native.connections.set(99, { address, onEvent })
            return 99
        }
        await expect(binding.open({ path: 'rfcomm:00-80-25-42-40-be', timeout: 20 })).rejects.toThrow('timeout')
    })

    test('invalid path', async () => {
        await expect(binding.open({ path: '/dev/cu.RACERS4240BE' })).rejects.toThrow('"path" is not valid')
    })

    test('pending read is canceled when the device closes the connection', async () => {
        const port = await open()
        const read = port.read(Buffer.alloc(64), 0, 64)
        native.emit(1, { type: 'close' })
        await expect(read).rejects.toThrow('port is closed')
        expect(port.isOpen).toBe(false)
    })

    test('close', async () => {
        const port = await open()
        await port.close()
        expect(port.isOpen).toBe(false)
        await expect(port.write(Buffer.from('ID'))).rejects.toThrow('Port is not open')
    })

    test('run loop is pumped outside of Electron while a port is open', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
        try {
            const opening = binding.open({ path: 'rfcomm:00-80-25-42-40-be' })
            jest.advanceTimersByTime(20)
            const port = await opening
            expect(native.pump).toHaveBeenCalled()

            const closing = port.close()
            jest.advanceTimersByTime(20)
            await closing
            native.pump.mockClear()
            jest.advanceTimersByTime(100)
            expect(native.pump).not.toHaveBeenCalled()
        }
        finally {
            jest.useRealTimers()
        }
    })
})

describe('combineWithRfcomm', () => {
    const serial = {
        list: jest.fn(async () => [{ path: '/dev/cu.usbserial' }]),
        open: jest.fn(async (options) => ({ via: 'serial', options }))
    }
    const rfcomm = {
        list: jest.fn(async () => [{ path: 'rfcomm:00-80-25-42-40-be' }]),
        open: jest.fn(async (options) => ({ via: 'rfcomm', options }))
    }

    test('without RFCOMM binding the serial binding is used as is', () => {
        expect(combineWithRfcomm(serial, null)).toBe(serial)
    })

    test('lists ports of both bindings', async () => {
        expect(await combineWithRfcomm(serial, rfcomm).list()).toEqual([{ path: '/dev/cu.usbserial' }, { path: 'rfcomm:00-80-25-42-40-be' }])
    })

    test('RFCOMM listing errors do not hide serial ports', async () => {
        const failing = { ...rfcomm, list: async () => { throw new Error('Bluetooth off') } }
        expect(await combineWithRfcomm(serial, failing).list()).toEqual([{ path: '/dev/cu.usbserial' }])
    })

    test('opens by path prefix', async () => {
        const combined = combineWithRfcomm(serial, rfcomm)
        expect((await combined.open({ path: 'rfcomm:00-80-25-42-40-be' })).via).toBe('rfcomm')
        expect((await combined.open({ path: '/dev/cu.usbserial' })).via).toBe('serial')
    })
})
