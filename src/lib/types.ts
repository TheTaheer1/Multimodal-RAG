export type FileStatus =
  | "UPLOADED"
  | "QUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "PARTIALLY_PROCESSED";

export type Modality = "pdf" | "image" | "video" | "audio" | "document";

export type EvidenceKind =
  | "native_text"
  | "ocr_text"
  | "vision_description"
  | "transcript"
  | "frame"
  | "speaker_segment"
  | "processing_note";

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ObservationInput = {
  fileId: string;
  modality: Modality;
  kind: EvidenceKind;
  content: string;
  pageNumber?: number | null;
  timestampStart?: number | null;
  timestampEnd?: number | null;
  frameTimestamp?: number | null;
  boundingBox?: BoundingBox | null;
  artifactPath?: string | null;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
};

export type ProcessingResult = {
  observations: ObservationInput[];
  warnings: string[];
};
