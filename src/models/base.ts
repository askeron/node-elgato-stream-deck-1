import { EventEmitter } from 'events'
import exitHook = require('exit-hook')
import * as HID from 'node-hid'

import { JPEGEncodeOptions } from '../jpeg'
import { DeviceModelId } from '../models'
import { numberArrayToString } from '../util'
import { KeyIndex, StreamDeckDeviceInfo } from './id'

export interface OpenStreamDeckOptions {
	useOriginalKeyOrder?: boolean
	resetToLogoOnExit?: boolean
	jpegOptions?: JPEGEncodeOptions
}

export interface StreamDeckProperties {
	MODEL: DeviceModelId
	COLUMNS: number
	ROWS: number
	ICON_SIZE: number
	KEY_DIRECTION: 'ltr' | 'rtl'
	KEY_DATA_OFFSET: number
}

export interface FillImageOptions {
	format: 'rgb' | 'rgba' | 'bgr' | 'bgra'
}
export type FillPanelOptions = FillImageOptions

export interface InternalFillImageOptions extends FillImageOptions {
	offset: number
	stride: number
}

export interface StreamDeck {
	readonly NUM_KEYS: number
	readonly KEY_COLUMNS: number
	readonly KEY_ROWS: number

	readonly ICON_SIZE: number
	readonly ICON_PIXELS: number
	readonly ICON_BYTES: number

	readonly MODEL: DeviceModelId

	/**
	 * Fills the given key with a solid color.
	 *
	 * @param {number} keyIndex The key to fill
	 * @param {number} r The color's red value. 0 - 255
	 * @param {number} g The color's green value. 0 - 255
	 * @param {number} b The color's blue value. 0 -255
	 */
	fillColor(keyIndex: KeyIndex, r: number, g: number, b: number): void

	/**
	 * Fills the given key with an image in a Buffer.
	 *
	 * @param {number} keyIndex The key to fill
	 * @param {Buffer} imageBuffer
	 * @param {Object} options
	 */
	fillImage(keyIndex: KeyIndex, imageBuffer: Buffer, options?: FillImageOptions): void

	/**
	 * Fills the whole panel with an image in a Buffer.
	 *
	 * @param {Buffer} imageBuffer
	 */
	fillPanel(imageBuffer: Buffer, options?: FillPanelOptions): void

	/**
	 * Clears the given key.
	 *
	 * @param {number} keyIndex The key to clear
	 */
	clearKey(keyIndex: KeyIndex): void

	/**
	 * Clears all keys.
	 */
	clearAllKeys(): void

	/**
	 * Sets the brightness of the keys on the Stream Deck
	 *
	 * @param {number} percentage The percentage brightness
	 */
	setBrightness(percentage: number): void

	/**
	 * Resets the display to the startup logo
	 */
	resetToLogo(): void

	/**
	 * Get firmware version from Stream Deck
	 */
	getFirmwareVersion(): string

	/**
	 * Get serial number from Stream Deck
	 */
	getSerialNumber(): string

	/**
	 * Close the Stream Deck
	 */
	close(): void

	on(event: 'down' | 'up', listener: (keyIndex: KeyIndex) => void): this
	on(event: 'error', listener: (e: unknown) => void): this
}

export abstract class StreamDeckBase extends EventEmitter implements StreamDeck {
	get NUM_KEYS(): number {
		return this.KEY_COLUMNS * this.KEY_ROWS
	}
	get KEY_COLUMNS(): number {
		return this.deviceProperties.COLUMNS
	}
	get KEY_ROWS(): number {
		return this.deviceProperties.ROWS
	}

	get ICON_SIZE(): number {
		return this.deviceProperties.ICON_SIZE
	}
	get ICON_BYTES(): number {
		return this.ICON_PIXELS * 3
	}
	get ICON_PIXELS(): number {
		return this.ICON_SIZE * this.ICON_SIZE
	}

	get MODEL(): DeviceModelId {
		return this.deviceProperties.MODEL
	}

	protected readonly options: Readonly<OpenStreamDeckOptions>

	private readonly device: HID.HID
	private readonly releaseExitHook: () => void
	private readonly deviceProperties: Readonly<StreamDeckProperties>
	private readonly keyState: boolean[]

	constructor(deviceInfo: StreamDeckDeviceInfo, options: OpenStreamDeckOptions, properties: StreamDeckProperties) {
		super()

		this.deviceProperties = properties
		this.options = options
		this.device = new HID.HID(deviceInfo.path)

		this.releaseExitHook = exitHook(() => {
			try {
				this.close()
			} catch (e) {
				// Ignore errors, as device is already closed
			}
		})

		this.keyState = new Array(this.NUM_KEYS).fill(false)

		this.device.on('data', (data) => {
			// The first byte is a report ID, the last byte appears to be padding.
			// We strip these out for now.
			data = data.slice(this.deviceProperties.KEY_DATA_OFFSET, data.length - 1)

			for (let i = 0; i < this.NUM_KEYS; i++) {
				const keyPressed = Boolean(data[i])
				const keyIndex = this.transformKeyIndex(i)
				const stateChanged = keyPressed !== this.keyState[keyIndex]
				if (stateChanged) {
					this.keyState[keyIndex] = keyPressed
					if (keyPressed) {
						this.emit('down', keyIndex)
					} else {
						this.emit('up', keyIndex)
					}
				}
			}
		})

		this.device.on('error', (err) => {
			this.emit('error', err)
		})
	}

	public fillColor(keyIndex: KeyIndex, r: number, g: number, b: number): void {
		this.checkValidKeyIndex(keyIndex)

		this.checkRGBValue(r)
		this.checkRGBValue(g)
		this.checkRGBValue(b)

		const pixels = Buffer.alloc(this.ICON_BYTES, Buffer.from([r, g, b]))
		const keyIndex2 = this.transformKeyIndex(keyIndex)

		// TODO - this could be cleverer and skip all the transform logic, but I dont expect it to be used enough to justify that
		this.fillImageRange(keyIndex2, pixels, {
			format: 'rgb',
			offset: 0,
			stride: this.ICON_SIZE * 3,
		})
	}

	public fillImage(keyIndex: KeyIndex, imageBuffer: Buffer, options?: FillImageOptions): void {
		this.checkValidKeyIndex(keyIndex)

		const sourceFormat = options?.format ?? 'rgb'
		this.checkSourceFormat(sourceFormat)

		const imageSize = this.ICON_PIXELS * sourceFormat.length
		if (imageBuffer.length !== imageSize) {
			throw new RangeError(`Expected image buffer of length ${imageSize}, got length ${imageBuffer.length}`)
		}

		const keyIndex2 = this.transformKeyIndex(keyIndex)
		this.fillImageRange(keyIndex2, imageBuffer, {
			format: sourceFormat,
			offset: 0,
			stride: this.ICON_SIZE * sourceFormat.length,
		})
	}

	public fillPanel(imageBuffer: Buffer, options?: FillPanelOptions): void {
		const sourceFormat = options?.format ?? 'rgb'
		this.checkSourceFormat(sourceFormat)

		const imageSize = this.ICON_PIXELS * sourceFormat.length * this.NUM_KEYS
		if (imageBuffer.length !== imageSize) {
			throw new RangeError(`Expected image buffer of length ${imageSize}, got length ${imageBuffer.length}`)
		}

		const iconSize = this.ICON_SIZE * sourceFormat.length
		const stride = iconSize * this.KEY_COLUMNS

		for (let row = 0; row < this.KEY_ROWS; row++) {
			const rowOffset = stride * row * this.ICON_SIZE

			for (let column = 0; column < this.KEY_COLUMNS; column++) {
				let index = row * this.KEY_COLUMNS
				if (this.deviceProperties.KEY_DIRECTION === 'ltr') {
					index += column
				} else {
					index += this.KEY_COLUMNS - column - 1
				}

				const colOffset = column * iconSize

				this.fillImageRange(index, imageBuffer, {
					format: sourceFormat,
					offset: rowOffset + colOffset,
					stride,
				})
			}
		}
	}

	public clearKey(keyIndex: KeyIndex): void {
		this.checkValidKeyIndex(keyIndex)
		return this.fillColor(keyIndex, 0, 0, 0)
	}

	public clearAllKeys(): void {
		// TODO - this could be restructured to be more efficient (by reusing the final colour buffer)
		for (let keyIndex = 0; keyIndex < this.NUM_KEYS; keyIndex++) {
			this.clearKey(keyIndex)
		}
	}

	public setBrightness(percentage: number): void {
		if (percentage < 0 || percentage > 100) {
			throw new RangeError('Expected brightness percentage to be between 0 and 100')
		}

		// prettier-ignore
		const brightnessCommandBuffer = Buffer.from([
			0x05, 0x55, 0xaa, 0xd1, 0x01, percentage, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00
		])
		this.device.sendFeatureReport(brightnessCommandBuffer)
	}

	public resetToLogo(): void {
		// prettier-ignore
		const resetCommandBuffer = Buffer.from([
			0x0B, 0x63, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00
		])
		this.device.sendFeatureReport(resetCommandBuffer)
	}

	public getFirmwareVersion(): string {
		return numberArrayToString(this.device.getFeatureReport(4, 17).slice(5))
	}

	public getSerialNumber(): string {
		return numberArrayToString(this.device.getFeatureReport(3, 17).slice(5, 17))
	}

	public close(): void {
		this.releaseExitHook()
		if (this.options.resetToLogoOnExit) {
			// This makes the reset happen much quicker than the default timeout
			this.resetToLogo()
		}
		this.device.close()
	}

	protected abstract transformKeyIndex(keyIndex: KeyIndex): KeyIndex

	protected abstract convertFillImage(imageBuffer: Buffer, sourceOptions: InternalFillImageOptions): Buffer

	protected getFillImageCommandHeaderLength(): number {
		return 16
	}

	protected writeFillImageCommandHeader(
		buffer: Buffer,
		keyIndex: number,
		partIndex: number,
		isLast: boolean,
		_bodyLength: number
	): void {
		buffer.writeUInt8(0x02, 0)
		buffer.writeUInt8(0x01, 1)
		buffer.writeUInt16LE(partIndex, 2)
		// 3 = 0x00
		buffer.writeUInt8(isLast ? 1 : 0, 4)
		buffer.writeUInt8(keyIndex + 1, 5)
	}

	protected abstract getFillImagePacketLength(): number

	protected generateFillImageWrites(keyIndex: KeyIndex, byteBuffer: Buffer): Buffer[] {
		const MAX_PACKET_SIZE = this.getFillImagePacketLength()
		const PACKET_HEADER_LENGTH = this.getFillImageCommandHeaderLength()
		const MAX_PAYLOAD_SIZE = MAX_PACKET_SIZE - PACKET_HEADER_LENGTH

		const result: Buffer[] = []

		let remainingBytes = byteBuffer.length
		for (let part = 0; remainingBytes > 0; part++) {
			const packet = Buffer.alloc(MAX_PACKET_SIZE)

			const byteCount = Math.min(remainingBytes, MAX_PAYLOAD_SIZE)
			this.writeFillImageCommandHeader(packet, keyIndex, part, remainingBytes <= MAX_PAYLOAD_SIZE, byteCount)

			const byteOffset = byteBuffer.length - remainingBytes
			remainingBytes -= byteCount
			byteBuffer.copy(packet, PACKET_HEADER_LENGTH, byteOffset, byteOffset + byteCount)

			result.push(packet)
		}

		return result
	}

	protected sendFeatureReport(payload: Buffer): number {
		return this.device.sendFeatureReport(payload)
	}
	protected getFeatureReport(reportId: number, reportLength: number): number[] {
		return this.device.getFeatureReport(reportId, reportLength)
	}

	private fillImageRange(keyIndex: KeyIndex, imageBuffer: Buffer, sourceOptions: InternalFillImageOptions): void {
		this.checkValidKeyIndex(keyIndex)

		const byteBuffer = this.convertFillImage(imageBuffer, sourceOptions)

		const packets = this.generateFillImageWrites(keyIndex, byteBuffer)
		for (const packet of packets) {
			this.device.write(packet)
		}
	}

	private checkValidKeyIndex(keyIndex: KeyIndex): void {
		if (keyIndex < 0 || keyIndex >= this.NUM_KEYS) {
			throw new TypeError(`Expected a valid keyIndex 0 - ${this.NUM_KEYS - 1}`)
		}
	}

	private checkRGBValue(value: number): void {
		if (value < 0 || value > 255) {
			throw new TypeError('Expected a valid color RGB value 0 - 255')
		}
	}

	private checkSourceFormat(format: 'rgb' | 'rgba' | 'bgr' | 'bgra'): void {
		switch (format) {
			case 'rgb':
			case 'rgba':
			case 'bgr':
			case 'bgra':
				break
			default: {
				const fmt: never = format
				throw new TypeError(`Expected a known color format not "${fmt}"`)
			}
		}
	}
}
