import { z } from "zod";

export const TranscriptChunkSchema = z.object({
  text: z.string().min(1, "text is required").max(10_000, "text is too long"),
  speakerId: z.string().max(100).optional(),
  timestamp: z.string().optional(),
  context: z.record(z.string(), z.string()).optional(),
});

export const CreateTagSchema = z.object({
  label: z.string().min(1, "label is required").max(200, "label is too long"),
  transcriptId: z.string().uuid("transcriptId must be a valid UUID").optional(),
  createdBy: z.string().max(100).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const UpdateContextSchema = z.object({
  context: z.record(z.string(), z.string()),
});

export const CreateSessionSchema = z.object({
  title: z.string().min(1, "title is required").max(200, "title is too long"),
  facilitator: z.string().max(100).optional(),
  audience: z.string().max(200).optional(),
  role: z.string().max(100).optional(),
  notes: z.string().max(5_000).optional(),
});

export const UpdateSessionStatusSchema = z.object({
  status: z.enum(["active", "paused", "ended"]),
});

export const CreateNoteSchema = z.object({
  body: z.string().max(10_000, "body is too long").default(""),
  transcriptId: z.string().uuid("transcriptId must be a valid UUID").optional(),
});

export const UpdateNoteSchema = z.object({
  body: z.string().min(1, "body is required").max(10_000, "body is too long"),
});

export const UpdatePromptSchema = z
  .object({
    dismissed: z.boolean().optional(),
    used: z.boolean().optional(),
  })
  .refine(
    (data) => data.dismissed !== undefined || data.used !== undefined,
    { message: "At least one of 'dismissed' or 'used' must be provided" },
  );

export const AddTagToNoteSchema = z.object({
  tagId: z.string().uuid("tagId must be a valid UUID"),
});

export type TranscriptChunkInput     = z.infer<typeof TranscriptChunkSchema>;
export type CreateTagInput           = z.infer<typeof CreateTagSchema>;
export type UpdateContextInput       = z.infer<typeof UpdateContextSchema>;
export type CreateSessionInput       = z.infer<typeof CreateSessionSchema>;
export type UpdateSessionStatusInput = z.infer<typeof UpdateSessionStatusSchema>;
export type CreateNoteInput          = z.infer<typeof CreateNoteSchema>;
export type UpdateNoteInput          = z.infer<typeof UpdateNoteSchema>;
export type UpdatePromptInput        = z.infer<typeof UpdatePromptSchema>;
export type AddTagToNoteInput        = z.infer<typeof AddTagToNoteSchema>;
