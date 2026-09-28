// apps/api-gateway/src/ai/ai.service.ts
//
// Claude for the IDE: streams replies from the Anthropic Messages API.
//
// The API key stays on the server (ANTHROPIC_API_KEY in backend/.env); the
// browser only talks to /api/ai/*. Settings:
//
//   ANTHROPIC_API_KEY     required to enable the assistant
//   ANTHROPIC_MODEL       default model (claude-sonnet-5)
//   ANTHROPIC_MODELS      comma-separated models users may pick
//                         (default: claude-sonnet-5,claude-opus-5-5,claude-haiku-4-5-20251001)
//   ANTHROPIC_MAX_TOKENS  reply length cap (default 4096)
//   ANTHROPIC_BASE_URL    optional, e.g. for a proxy

import { Injectable, Logger } from '@nestjs/common';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ChatContext {
    /** Workspace name, for the system prompt. */
    workspaceName?: string;
    /** Project file paths (for structure). */
    files?: string[];
    /** The file open in the editor. */
    activeFile?: { path: string; content: string; selection?: string };
    /** Build or test output the user wants explained. */
    output?: { kind: 'build' | 'test' | 'terminal'; content: string };
}

export interface StreamHandlers {
    onText: (text: string) => void;
    signal: AbortSignal;
}

export interface StreamResult {
    model: string;
    stopReason: string | null;
    inputTokens: number;
    outputTokens: number;
}

/** Friendly names for the model picker. Unknown ids show as-is. */
const MODEL_LABELS: Record<string, string> = {
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-fable-5-1': 'Claude Fable 5.1',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
};

const MODEL_NOTES: Record<string, string> = {
    'claude-sonnet-5': 'Balanced speed and quality',
    'claude-opus-5-5': 'Strongest for hard coding problems',
    'claude-fable-5-1': 'Deepest reasoning; slowest',
    'claude-haiku-4-5-20251001': 'Fastest answers',
};

// Keep requests bounded: these are per request, after trimming.
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARS = 120_000;
const MAX_FILE_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_FILE_LIST = 400;

const SYSTEM_PROMPT = `You are Claude, the coding assistant built into Corven, a browser IDE for Nervos CKB smart contracts.

Each workspace is a Rust project generated from cryptape/ckb-script-templates:
- contracts live in contracts/<name>/src/main.rs and build for riscv64imac-unknown-none-elf (no_std, using ckb-std);
- \`make build\` builds every contract into build/release/<name>;
- tests live in tests/ and use ckb-testtool (\`make test\` runs them natively);
- \`ckb-debugger --bin build/release/<name>\` runs a contract locally;
- a CKB devnet (offckb) is available at http://ckb-node:8114 once the user starts it;
- workspaces start from a template: hello-world, simple-udt (an sUDT token type script) or time-lock (a lock script using since);
- Molecule schemas (.mol) get bindings from moleculec: the editor writes <name>.rs next to the schema, used with molecule = { version = "0.9", default-features = false }.

How to help:
- Be concrete and brief. Lead with the answer or the fix, then explain only what matters.
- When you change code, show the complete changed function or file section in a fenced code block labelled with the language, and name the file path above it.
- Respect CKB constraints: no std, no heap unless the contract sets up an allocator via ckb-std's default_alloc!, cycles matter, scripts return i8 error codes.
- For build or test failures, identify the first real error, say what causes it, and give the smallest fix.
- If something depends on information you don't have (a file you haven't seen, versions), say so instead of guessing.`;

function tail(text: string, max: number): string {
    return text.length <= max ? text : `[... ${text.length - max} earlier characters omitted ...]\n${text.slice(-max)}`;
}

function head(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters omitted ...]`;
}

@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name);

    get enabled(): boolean {
        return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    }

    get defaultModel(): string {
        return process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5';
    }

    get models(): string[] {
        const configured = (process.env.ANTHROPIC_MODELS ?? 'claude-sonnet-5,claude-opus-5-5,claude-haiku-4-5-20251001')
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean);

        return [...new Set([this.defaultModel, ...configured])];
    }

    status() {
        return {
            enabled: this.enabled,
            defaultModel: this.defaultModel,
            models: this.models.map((id) => ({
                id,
                name: MODEL_LABELS[id] ?? id,
                description: MODEL_NOTES[id] ?? '',
            })),
        };
    }

    /** Picks an allowed model; anything else falls back to the default. */
    resolveModel(requested?: string): string {
        return requested && this.models.includes(requested) ? requested : this.defaultModel;
    }

    /** Normalises client-sent history: alternating turns, bounded size, ends with the user. */
    prepareMessages(input: unknown): ChatMessage[] {
        if (!Array.isArray(input)) return [];

        const cleaned: ChatMessage[] = [];

        for (const item of input.slice(-MAX_HISTORY_MESSAGES)) {
            const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
            const content = typeof item?.content === 'string' ? item.content.trim() : '';
            if (!role || !content) continue;

            // Merge consecutive turns from the same side (the API requires alternation).
            const last = cleaned[cleaned.length - 1];
            if (last && last.role === role) {
                last.content += `\n\n${content}`;
            } else {
                cleaned.push({ role, content });
            }
        }

        // Drop oldest turns beyond the size budget.
        let total = cleaned.reduce((sum, m) => sum + m.content.length, 0);
        while (cleaned.length > 1 && total > MAX_HISTORY_CHARS) {
            total -= cleaned.shift()!.content.length;
        }

        while (cleaned.length && cleaned[0].role !== 'user') cleaned.shift();

        return cleaned.length && cleaned[cleaned.length - 1].role === 'user' ? cleaned : [];
    }

    /** The per-request part of the system prompt. */
    buildContext(context: ChatContext): string {
        const parts: string[] = [];

        if (context.workspaceName) parts.push(`Workspace: ${context.workspaceName}`);

        if (context.files?.length) {
            const list = context.files.slice(0, MAX_FILE_LIST);
            parts.push(
                `Project files${context.files.length > list.length ? ` (first ${list.length} of ${context.files.length})` : ''}:\n${list.join('\n')}`,
            );
        }

        if (context.activeFile?.path) {
            parts.push(
                `The user has this file open: ${context.activeFile.path}\n<file path="${context.activeFile.path}">\n${head(context.activeFile.content ?? '', MAX_FILE_CHARS)}\n</file>`,
            );

            if (context.activeFile.selection?.trim()) {
                parts.push(`Selected text in that file:\n<selection>\n${head(context.activeFile.selection, 8_000)}\n</selection>`);
            }
        }

        if (context.output?.content?.trim()) {
            parts.push(
                `Latest ${context.output.kind} output:\n<output kind="${context.output.kind}">\n${tail(context.output.content, MAX_OUTPUT_CHARS)}\n</output>`,
            );
        }

        return parts.join('\n\n');
    }

    /**
     * Streams a reply. Calls onText for each text delta and resolves with
     * usage when the reply is complete. Throws AiError on API failures.
     */
    async stream(
        model: string,
        messages: ChatMessage[],
        context: string,
        handlers: StreamHandlers,
    ): Promise<StreamResult> {
        const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
        if (!apiKey) throw new AiError(503, 'The AI assistant is not configured on this server.');

        const baseUrl = (process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com').replace(/\/$/, '');
        const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS) || 4096;

        const system: Array<Record<string, unknown>> = [
            // Stable across requests: cache it.
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ];
        if (context) system.push({ type: 'text', text: context });

        let response: Response;

        try {
            response = await fetch(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: maxTokens,
                    system,
                    messages,
                    stream: true,
                }),
                signal: handlers.signal,
            });
        } catch (error) {
            if (handlers.signal.aborted) throw new AiError(499, 'Request cancelled');
            this.logger.error(`Anthropic API unreachable: ${error instanceof Error ? error.message : error}`);
            throw new AiError(502, 'Could not reach the AI service. Try again in a moment.');
        }

        if (!response.ok || !response.body) {
            const detail = await response.text().catch(() => '');
            this.logger.warn(`Anthropic API ${response.status}: ${detail.slice(0, 500)}`);
            throw new AiError(response.status, this.describeApiError(response.status, detail));
        }

        const result: StreamResult = { model, stopReason: null, inputTokens: 0, outputTokens: 0 };

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const handleEvent = (raw: string) => {
            let data = '';
            for (const line of raw.split('\n')) {
                if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) return;

            let event: any;
            try {
                event = JSON.parse(data);
            } catch {
                return;
            }

            switch (event.type) {
                case 'message_start':
                    result.inputTokens =
                        (event.message?.usage?.input_tokens ?? 0) +
                        (event.message?.usage?.cache_read_input_tokens ?? 0) +
                        (event.message?.usage?.cache_creation_input_tokens ?? 0);
                    break;
                case 'content_block_delta':
                    if (event.delta?.type === 'text_delta' && event.delta.text) handlers.onText(event.delta.text);
                    break;
                case 'message_delta':
                    result.stopReason = event.delta?.stop_reason ?? result.stopReason;
                    result.outputTokens = event.usage?.output_tokens ?? result.outputTokens;
                    break;
                case 'error':
                    throw new AiError(502, event.error?.message ?? 'The AI service returned an error.');
            }
        };

        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                let boundary: number;
                while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                    handleEvent(buffer.slice(0, boundary));
                    buffer = buffer.slice(boundary + 2);
                }
            }

            if (buffer.trim()) handleEvent(buffer);
        } catch (error) {
            if (error instanceof AiError) throw error;
            if (handlers.signal.aborted) throw new AiError(499, 'Request cancelled');
            throw new AiError(502, 'The reply was interrupted. Try again.');
        }

        return result;
    }

    private describeApiError(status: number, detail: string): string {
        if (status === 401 || status === 403) return 'The server’s Anthropic API key was rejected. Check ANTHROPIC_API_KEY.';
        if (status === 404) return 'The selected model is not available for this API key.';
        if (status === 429) return 'The AI service is busy (rate limited). Try again shortly.';
        if (status === 529 || status >= 500) return 'The AI service is temporarily overloaded. Try again shortly.';

        try {
            const message = JSON.parse(detail)?.error?.message;
            if (typeof message === 'string' && message) return message;
        } catch {
            /* not JSON */
        }

        return `The AI request failed (${status}).`;
    }
}

export class AiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}
