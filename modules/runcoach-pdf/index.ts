import { requireNativeModule } from 'expo-modules-core';

export interface PdfText { text: string; pageCount: number; hasTextLayer: boolean }

/** Extract a PDF's text layer. hasTextLayer=false ⇒ scanned/image-only, needs OCR instead. */
export async function extractPdfText(uri: string): Promise<PdfText> {
  const mod = requireNativeModule('RunCoachPdf');
  return await mod.extractText(uri);
}

/**
 * Product barcodes (EAN-13/EAN-8/UPC-E) found in a photo, decoded on-device by iOS Vision. Returns null when the
 * installed app build doesn't have the function yet (an OTA ahead of the native build) — callers then say so.
 */
export async function detectBarcodes(uri: string): Promise<string[] | null> {
  try {
    const mod = requireNativeModule('RunCoachPdf');
    if (typeof mod.detectBarcodes !== 'function') return null;
    return await mod.detectBarcodes(uri);
  } catch { return null; }
}

/**
 * LIVE barcode scanner (VisionKit DataScannerViewController): point → resolves with the digits.
 * null = cancelled · 'unsupported' / 'unavailable' = can't run here (fall back to the photo path or typed digits)
 * · undefined = the installed app build doesn't have it yet (an OTA ahead of the native build).
 */
export async function scanBarcodeLive(): Promise<string | null | 'unsupported' | 'unavailable' | undefined> {
  try {
    const mod = requireNativeModule('RunCoachPdf');
    if (typeof mod.scanBarcodeLive !== 'function') return undefined;
    return await mod.scanBarcodeLive();
  } catch { return undefined; }
}
