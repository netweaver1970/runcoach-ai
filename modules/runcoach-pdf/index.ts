import { requireNativeModule } from 'expo-modules-core';

export interface PdfText { text: string; pageCount: number; hasTextLayer: boolean }

/** Extract a PDF's text layer. hasTextLayer=false ⇒ scanned/image-only, needs OCR instead. */
export async function extractPdfText(uri: string): Promise<PdfText> {
  const mod = requireNativeModule('RunCoachPdf');
  return await mod.extractText(uri);
}
