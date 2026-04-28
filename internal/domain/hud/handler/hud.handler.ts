import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import { created, ok } from "@/internal/pkg/ApiResponse";
import { AppError } from "@/internal/pkg/AppError";
import SC from "@/internal/pkg/response";
import { HudSessionService } from "@/internal/domain/hud/service/session.service";
import {
  AddTagToNoteInput,
  CreateNoteInput,
  CreateSessionInput,
  CreateTagInput,
  TranscriptChunkInput,
  UpdateContextInput,
  UpdateNoteInput,
  UpdatePromptInput,
  UpdateSessionStatusInput,
} from "@/internal/validation/hud.schemas";

export class HudHandler {
  constructor(private readonly service: HudSessionService) {}

  createSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return next(new AppError("Authentication required", 0, SC.UNAUTHORIZED));
      }
      const { title, facilitator = '', audience = '', role = '' } = req.body as CreateSessionInput;
      const session = await this.service.createSession({
        id: randomUUID(),
        title,
        facilitator,
        audience,
        role,
        createdBy: userId,
      });
      const summary = { id: session.id, title: session.title, status: session.status, createdAt: session.createdAt };
      res.status(SC.CREATED).json(created(summary, "Session created"));
    } catch (error) {
      next(error);
    }
  };

  listSessions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return next(new AppError("Authentication required", 0, SC.UNAUTHORIZED));
      }
      const sessions = await this.service.listSessions(userId);
      const summaries = sessions.map(s => ({ id: s.id, title: s.title, status: s.status, noteCount: s.noteCount ?? 0, createdAt: s.createdAt }));
      res.status(SC.OK).json(ok(summaries, "Sessions fetched"));
    } catch (error) {
      next(error);
    }
  };

  getSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const session = await this.service.getSession(sessionId);
      if (!session) throw new AppError('Session not found', 0, SC.NOT_FOUND);
      res.status(SC.OK).json(ok({ id: session.id, title: session.title, status: session.status, createdAt: session.createdAt }, "Session fetched"));
    } catch (error) {
      next(error);
    }
  };

  deleteSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      await this.service.deleteSession(sessionId);
      res.status(SC.OK).json(ok({ sessionId }, "Session deleted"));
    } catch (error) {
      next(error);
    }
  };

  updateContext = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const { context } = req.body as UpdateContextInput;
      const snapshot = await this.service.updateSessionContext({
        sessionId,
        context,
      });

      res.status(SC.OK).json(ok(snapshot, "Session context updated"));
    } catch (error) {
      next(error);
    }
  };

  updateSessionStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const { status } = req.body as UpdateSessionStatusInput;
      await this.service.updateSessionStatus(sessionId, status);
      res.status(SC.OK).json(ok({ sessionId, status }, "Session status updated"));
    } catch (error) {
      next(error);
    }
  };

  createTranscriptChunk = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const sessionId = this.requireSessionId(req);
      const { text, speakerId, timestamp, context } = req.body as TranscriptChunkInput;

      const result = await this.service.processTranscriptChunk({
        sessionId,
        text,
        speakerId,
        timestamp,
        context,
      });

      res
        .status(SC.CREATED)
        .json(created(result, "Transcript chunk processed"));
    } catch (error) {
      next(error);
    }
  };

  createTag = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const { label, transcriptId, createdBy, metadata } = req.body as CreateTagInput;

      const tag = await this.service.createTag({
        sessionId,
        label,
        transcriptId,
        createdBy,
        metadata,
      });

      res.status(SC.CREATED).json(created(tag, "Tag created"));
    } catch (error) {
      next(error);
    }
  };

  exportSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const format = req.query.format === "csv" ? "csv" : "json";
      const result = await this.service.exportSession(sessionId, format);

      res.setHeader("Content-Type", result.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${result.filename}"`,
      );
      res.status(SC.OK).send(result.body);
    } catch (error) {
      next(error);
    }
  };

  createNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const { body, transcriptId } = req.body as CreateNoteInput;
      const note = await this.service.createNote({ id: randomUUID(), sessionId, label: '', body });
      res.status(SC.CREATED).json(created({ id: note.id, body: note.body, transcriptId }, "Note created"));
    } catch (error) {
      next(error);
    }
  };

  listNotes = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const notes = await this.service.listNotes(sessionId);
      res.status(SC.OK).json(ok(notes, "Notes fetched"));
    } catch (error) {
      next(error);
    }
  };

  updateNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const noteId = this.requireNoteId(req);
      const { body } = req.body as UpdateNoteInput;
      await this.service.updateNote(sessionId, noteId, body);
      res.status(SC.OK).json(ok({ sessionId, noteId, body }, "Note updated"));
    } catch (error) {
      next(error);
    }
  };

  deleteNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const noteId = this.requireNoteId(req);
      await this.service.deleteNote(sessionId, noteId);
      res.status(SC.OK).json(ok({ sessionId, noteId }, "Note deleted"));
    } catch (error) {
      next(error);
    }
  };

  listPrompts = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      res.status(SC.OK).json(ok({ sessionId, prompts: [] }, "Prompts fetched"));
    } catch (error) {
      next(error);
    }
  };

  updatePrompt = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const promptId = this.requirePromptId(req);
      const { dismissed, used } = req.body as UpdatePromptInput;
      res.status(SC.OK).json(ok({ sessionId, promptId, dismissed, used }, "Prompt updated"));
    } catch (error) {
      next(error);
    }
  };

  addTagToNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const noteId = this.requireNoteId(req);
      const { tagId } = req.body as AddTagToNoteInput;
      await this.service.addTagToNote(noteId, tagId);
      res.status(SC.CREATED).json(created({ sessionId, noteId, tagId }, "Tag added to note"));
    } catch (error) {
      next(error);
    }
  };

  removeTagFromNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = this.requireSessionId(req);
      const noteId = this.requireNoteId(req);
      const tagId = this.requireParam(req, "tagId", "Tag ID");
      await this.service.removeTagFromNote(noteId, tagId);
      res.status(SC.OK).json(ok({ sessionId, noteId, tagId }, "Tag removed from note"));
    } catch (error) {
      next(error);
    }
  };

  private requireSessionId(req: Request) {
    const sessionId = req.params.sessionId;
    if (!sessionId || Array.isArray(sessionId)) {
      throw new AppError("Session ID is required", 0, SC.BAD_REQUEST);
    }
    if (sessionId.length > 200) {
      throw new AppError("Session ID is too long", 0, SC.BAD_REQUEST);
    }

    return sessionId;
  }

  private requireNoteId(req: Request) {
    return this.requireParam(req, "noteId", "Note ID");
  }

  private requirePromptId(req: Request) {
    return this.requireParam(req, "promptId", "Prompt ID");
  }

  private requireParam(req: Request, name: string, label: string) {
    const value = req.params[name];
    if (!value || Array.isArray(value)) {
      throw new AppError(`${label} is required`, 0, SC.BAD_REQUEST);
    }
    if (value.length > 200) {
      throw new AppError(`${label} is too long`, 0, SC.BAD_REQUEST);
    }

    return value;
  }
}
