import fs from "node:fs";
import path from "node:path";

interface SavedLabelInfo {
  fileName: string;
  filePath: string;
  publicUrl: string;
}

export class LabelStorageService {
  private readonly resolvedStoragePath: string;

  constructor(storagePath: string) {
    this.resolvedStoragePath = path.resolve(storagePath);
    fs.mkdirSync(this.resolvedStoragePath, { recursive: true });
  }

  save(
    fileNameHint: string,
    contents: Buffer,
    extension: string,
    mimeType: string
  ): SavedLabelInfo {
    if (contents.length === 0) {
      throw new Error("Label contents are empty.");
    }

    const safeHint = this.toSafeToken(fileNameHint);
    const safeExt = this.toSafeToken(extension).toLowerCase() || "bin";
    const timestamp = Date.now();
    const fileName = `${safeHint}-${timestamp}.${safeExt}`;
    const absolutePath = path.join(this.resolvedStoragePath, fileName);

    fs.writeFileSync(absolutePath, contents);

    return {
      fileName,
      filePath: absolutePath,
      publicUrl: `/api/labels/${encodeURIComponent(fileName)}`
    };
  }

  savePdfLabel(orderId: string, trackingNumber: string, labelDataUrl: string): SavedLabelInfo {
    const match = labelDataUrl.match(/^data:application\/pdf;base64,(.+)$/i);

    if (!match) {
      throw new Error("Label payload is not a PDF data URL.");
    }

    const base64Contents = match[1];
    let buffer: Buffer;

    try {
      buffer = Buffer.from(base64Contents, "base64");
    } catch {
      throw new Error("Unable to decode label PDF contents from base64.");
    }

    if (buffer.length === 0) {
      throw new Error("Decoded label PDF is empty.");
    }

    const legacyOrderId = orderId.split("/").pop() ?? orderId;
    const safeOrderId = this.toSafeToken(legacyOrderId);
    return this.save(
      `labels_${safeOrderId}`,
      buffer,
      "pdf",
      "application/pdf"
    );
  }

  resolveLabelFilePath(fileName: string): string {
    const decodedFileName = decodeURIComponent(fileName);
    const absolutePath = path.resolve(this.resolvedStoragePath, decodedFileName);

    if (!absolutePath.startsWith(this.resolvedStoragePath)) {
      throw new Error("Invalid label file path.");
    }

    return absolutePath;
  }

  get(fileName: string): Buffer {
    const absolutePath = this.resolveLabelFilePath(fileName);
    return fs.readFileSync(absolutePath);
  }

  delete(fileName: string): void {
    const absolutePath = this.resolveLabelFilePath(fileName);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  }

  private toSafeToken(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
    return sanitized.slice(0, 80) || "na";
  }
}
