export interface QR {
  addData(data: string): void;
  make(): void;
  createSvgTag(opts?: { cellSize?: number; margin?: number; scalable?: boolean }): string;
}
export function qrcode(typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'): QR;
export default qrcode;
