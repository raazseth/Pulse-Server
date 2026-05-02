import { RequestHandler, Router } from "express";
import { HudHandler } from "@/internal/domain/hud/handler/hud.handler";
import { validateBody } from "@/internal/middleware/validate";
import {
  AddTagToNoteSchema,
  CreateNoteSchema,
  CreateSessionSchema,
  CreateTagSchema,
  TranscriptChunkSchema,
  UpdateContextSchema,
  UpdateNoteSchema,
  UpdatePromptSchema,
  UpdateSessionStatusSchema,
} from "@/internal/validation/hud.schemas";

export function HudRoutes(handler: HudHandler, authenticate: RequestHandler) {
  const router = Router();

  router.post("/sessions", authenticate, validateBody(CreateSessionSchema), handler.createSession);
  router.get("/sessions", authenticate, handler.listSessions);
  router.get("/sessions/:sessionId", authenticate, handler.getSession);
  router.delete("/sessions/:sessionId", authenticate, handler.deleteSession);
  router.patch("/sessions/:sessionId/context", authenticate, validateBody(UpdateContextSchema), handler.updateContext);
  router.patch("/sessions/:sessionId/status", authenticate, validateBody(UpdateSessionStatusSchema), handler.updateSessionStatus);
  router.post("/sessions/:sessionId/start", authenticate, handler.startSession);
  router.post("/sessions/:sessionId/stop", authenticate, handler.stopSession);

  router.post("/sessions/:sessionId/transcript", authenticate, validateBody(TranscriptChunkSchema), handler.createTranscriptChunk);
  router.post("/sessions/:sessionId/tags", authenticate, validateBody(CreateTagSchema), handler.createTag);
  router.get("/sessions/:sessionId/export", authenticate, handler.exportSession);

  router.post("/sessions/:sessionId/notes", authenticate, validateBody(CreateNoteSchema), handler.createNote);
  router.get("/sessions/:sessionId/notes", authenticate, handler.listNotes);
  router.patch("/sessions/:sessionId/notes/:noteId", authenticate, validateBody(UpdateNoteSchema), handler.updateNote);
  router.delete("/sessions/:sessionId/notes/:noteId", authenticate, handler.deleteNote);

  // GET /sessions/:sessionId/prompts — not integrated; prompts are pushed via WS prompt:update
  // router.get("/sessions/:sessionId/prompts", authenticate, handler.listPrompts);
  router.patch("/sessions/:sessionId/prompts/:promptId", authenticate, validateBody(UpdatePromptSchema), handler.updatePrompt);

  router.post("/sessions/:sessionId/notes/:noteId/tags", authenticate, validateBody(AddTagToNoteSchema), handler.addTagToNote);
  router.delete("/sessions/:sessionId/notes/:noteId/tags/:tagId", authenticate, handler.removeTagFromNote);

  return router;
}
