import { describe, expect, it } from 'vitest'
import { looksBinary, decideWrite, MAX_READ_BYTES } from '../fs-service'

describe('looksBinary', () => {
  it('含 NUL 字节判为二进制', () => {
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true)
  })
  it('正常文本判为文本', () => {
    expect(looksBinary(Buffer.from('中文 console.log("hi")\n'))).toBe(false)
  })
})

describe('decideWrite', () => {
  it('无基线（新文件或强制覆盖）放行', () => {
    expect(decideWrite(undefined, 123)).toBe('ok')
  })
  it('基线与磁盘一致放行', () => {
    expect(decideWrite(123, 123)).toBe('ok')
  })
  it('磁盘 mtime 变化判冲突', () => {
    expect(decideWrite(123, 456)).toBe('conflict')
  })
  it('MAX_READ_BYTES 为 1MB', () => {
    expect(MAX_READ_BYTES).toBe(1024 * 1024)
  })
})
