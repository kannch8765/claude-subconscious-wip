/**
 * Transcript Utilities
 *
 * Shared utilities for reading and formatting Claude Code transcripts.
 * Used by send_messages_to_letta.ts.
 */

import * as fs from 'fs';
import * as readline from 'readline';

// Types for transcript parsing
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;        // tool name for tool_use
  id?: string;          // tool_use_id
  input?: any;          // tool input
  tool_use_id?: string; // for tool_result
  content?: string;     // tool result content
  is_error?: boolean;   // tool error flag
}

export interface TranscriptMessage {
  type: string;
  role?: string;
  content?: string | ContentBlock[];
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  tool_name?: string;
  tool_input?: any;
  tool_result?: any;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;   // raw Claude transcript parent edge
  // Summary message fields
  summary?: string;
  // System message fields
  subtype?: string;
  stopReason?: string;
  // File history fields
  snapshot?: {
    trackedFileBackups?: Record<string, any>;
  };
}

export interface ExtractedContent {
  text: string | null;
  thinking: string | null;
  toolUses: Array<{ name: string; input: any }>;
  toolResults: Array<{ toolName: string; content: string; isError: boolean }>;
}

export type LogFn = (message: string) => void;

// Default no-op logger
const noopLog: LogFn = () => {};

/**
 * Read transcript JSONL file and parse messages
 */
export async function readTranscript(transcriptPath: string, log: LogFn = noopLog): Promise<TranscriptMessage[]> {
  if (!fs.existsSync(transcriptPath)) {
    log(`Transcript file not found: ${transcriptPath}`);
    return [];
  }

  const messages: TranscriptMessage[] = [];
  const fileStream = fs.createReadStream(transcriptPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        log(`Failed to parse transcript line: ${e}`);
      }
    }
  }

  return messages;
}

export interface TranscriptUserTurnAnchor {
  tail_role: 'user' | 'assistant' | 'none';
  tail_message_id?: string;
  last_user_message_id?: string;
}

/**
 * Observe only transcript structure for foreground turn binding. This never
 * compares prompt text: Stop later uses the durable order plus real UUIDs.
 */
export function readTranscriptUserTurnAnchor(
  transcriptPath: string,
  maxTailBytes = 4 * 1024 * 1024,
): TranscriptUserTurnAnchor {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { tail_role: 'none' };
  const stat = fs.statSync(transcriptPath);
  if (stat.size <= 0) return { tail_role: 'none' };
  const length = Math.min(stat.size, Math.max(4096, maxTailBytes));
  const start = stat.size - length;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline < 0) return { tail_role: 'none' };
      text = text.slice(firstNewline + 1);
    }
    let tailRole: 'user' | 'assistant' | 'none' = 'none';
    let tailMessageId: string | undefined;
    let lastUserMessageId: string | undefined;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let message: TranscriptMessage;
      try { message = JSON.parse(line) as TranscriptMessage; } catch { continue; }
      if (message.type !== 'user' && message.type !== 'assistant') continue;
      // This is a structural anchor, not a visible-context filter. Thinking-only
      // and tool-only assistant records still delimit user turns.
      tailRole = message.type;
      tailMessageId = message.uuid;
      if (message.type === 'user' && message.uuid && extractAllContent(message).text?.trim()) {
        lastUserMessageId = message.uuid;
      }
    }
    return {
      tail_role: tailRole,
      ...(tailMessageId ? { tail_message_id: tailMessageId } : {}),
      ...(lastUserMessageId ? { last_user_message_id: lastUserMessageId } : {}),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Resolve the real Claude transcript UUID for the current UserPromptSubmit without
 * scanning the whole transcript. Only an exact visible-text match is accepted; a
 * miss is intentionally non-fatal so downstream receipt reuse can safely fall back.
 */
export function findLatestUserMessageUuidForPrompt(
  transcriptPath: string,
  prompt: string,
  maxTailBytes = 4 * 1024 * 1024,
): string | undefined {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt || !fs.existsSync(transcriptPath)) return undefined;
  const stat = fs.statSync(transcriptPath);
  if (stat.size <= 0) return undefined;
  const length = Math.min(stat.size, Math.max(4096, maxTailBytes));
  const start = stat.size - length;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline < 0) return undefined;
      text = text.slice(firstNewline + 1);
    }
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let message: TranscriptMessage;
      try { message = JSON.parse(line) as TranscriptMessage; }
      catch { continue; }
      if (message.type !== 'user' || !message.uuid) continue;
      const visible = extractAllContent(message).text?.trim();
      if (visible === normalizedPrompt) return message.uuid;
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Extract different content types from a message
 */
export function extractAllContent(msg: TranscriptMessage): ExtractedContent {
  const result: ExtractedContent = {
    text: null,
    thinking: null,
    toolUses: [],
    toolResults: [],
  };

  const content = msg.message?.content ?? msg.content;

  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'thinking' && block.thinking) {
        thinkingParts.push(block.thinking);
      } else if (block.type === 'tool_use' && block.name) {
        result.toolUses.push({
          name: block.name,
          input: block.input,
        });
      } else if (block.type === 'tool_result') {
        const resultContent = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        result.toolResults.push({
          toolName: block.tool_use_id || 'unknown',
          content: resultContent,
          isError: block.is_error || false,
        });
      }
    }

    if (textParts.length > 0) {
      result.text = textParts.join('\n');
    }
    if (thinkingParts.length > 0) {
      result.thinking = thinkingParts.join('\n');
    }
  }

  return result;
}

/**
 * Truncate text to a maximum length
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '... [truncated]';
}

/**
 * Format messages for Letta with rich context
 */
export function formatMessagesForLetta(
  messages: TranscriptMessage[],
  startIndex: number,
  log: LogFn = noopLog
): Array<{role: string, text: string}> {
  const formatted: Array<{role: string, text: string}> = [];
  const toolNameMap: Map<string, string> = new Map(); // tool_use_id -> tool_name

  log(`Formatting messages from index ${startIndex + 1} to ${messages.length - 1}`);

  for (let i = startIndex + 1; i < messages.length; i++) {
    const msg = messages[i];

    log(`  Message ${i}: type=${msg.type}`);

    // Handle summary messages
    if (msg.type === 'summary' && msg.summary) {
      formatted.push({
        role: 'system',
        text: `[Session Summary]: ${msg.summary}`,
      });
      log(`    -> Added summary`);
      continue;
    }

    // Skip file-history-snapshot and system messages (internal)
    if (msg.type === 'file-history-snapshot' || msg.type === 'system') {
      continue;
    }

    // Handle user messages
    if (msg.type === 'user') {
      const extracted = extractAllContent(msg);

      // User text input
      if (extracted.text) {
        formatted.push({ role: 'user', text: extracted.text });
        log(`    -> Added user message (${extracted.text.length} chars)`);
      }

      // Tool results (these come in user messages)
      for (const toolResult of extracted.toolResults) {
        const toolName = toolNameMap.get(toolResult.toolName) || toolResult.toolName;
        const prefix = toolResult.isError ? '[Tool Error' : '[Tool Result';
        const truncatedContent = truncate(toolResult.content, 1500);
        formatted.push({
          role: 'system',
          text: `${prefix}: ${toolName}]\n${truncatedContent}`,
        });
        log(`    -> Added tool result for ${toolName} (error: ${toolResult.isError})`);
      }
    }

    // Handle assistant messages
    else if (msg.type === 'assistant') {
      const extracted = extractAllContent(msg);

      // Track tool names for later result mapping
      for (const toolUse of extracted.toolUses) {
        if (toolUse.input?.id) {
          toolNameMap.set(toolUse.input.id, toolUse.name);
        }
      }

      // Assistant thinking (summarized)
      if (extracted.thinking) {
        const truncatedThinking = truncate(extracted.thinking, 500);
        formatted.push({
          role: 'assistant',
          text: `[Thinking]: ${truncatedThinking}`,
        });
        log(`    -> Added thinking (${extracted.thinking.length} chars, truncated to 500)`);
      }

      // Tool calls
      for (const toolUse of extracted.toolUses) {
        // Format tool input concisely
        let inputSummary = '';
        if (toolUse.input) {
          if (toolUse.name === 'Read' && toolUse.input.file_path) {
            inputSummary = toolUse.input.file_path;
          } else if (toolUse.name === 'Edit' && toolUse.input.file_path) {
            inputSummary = toolUse.input.file_path;
          } else if (toolUse.name === 'Write' && toolUse.input.file_path) {
            inputSummary = toolUse.input.file_path;
          } else if (toolUse.name === 'Bash' && toolUse.input.command) {
            inputSummary = truncate(toolUse.input.command, 100);
          } else if (toolUse.name === 'Glob' && toolUse.input.pattern) {
            inputSummary = toolUse.input.pattern;
          } else if (toolUse.name === 'Grep' && toolUse.input.pattern) {
            inputSummary = toolUse.input.pattern;
          } else if (toolUse.name === 'WebFetch' && toolUse.input.url) {
            inputSummary = toolUse.input.url;
          } else if (toolUse.name === 'WebSearch' && toolUse.input.query) {
            inputSummary = toolUse.input.query;
          } else if (toolUse.name === 'Task' && toolUse.input.description) {
            inputSummary = toolUse.input.description;
          } else if (toolUse.name === 'AskUserQuestion' && toolUse.input.questions) {
            // Summarize questions being asked
            const questions = toolUse.input.questions;
            if (Array.isArray(questions) && questions.length > 0) {
              inputSummary = questions.map((q: any) => q.question || q.header || '').join('; ');
              inputSummary = truncate(inputSummary, 100);
            }
          } else if (toolUse.name === 'ExitPlanMode') {
            inputSummary = 'Exiting plan mode';
          } else {
            inputSummary = truncate(JSON.stringify(toolUse.input), 100);
          }
        }

        formatted.push({
          role: 'assistant',
          text: `[Tool: ${toolUse.name}] ${inputSummary}`,
        });
        log(`    -> Added tool use: ${toolUse.name}`);
      }

      // Assistant text response
      if (extracted.text) {
        formatted.push({ role: 'assistant', text: extracted.text });
        log(`    -> Added assistant text (${extracted.text.length} chars)`);
      }
    }
  }

  log(`Formatted ${formatted.length} messages total`);
  return formatted;
}

/**
 * Format messages as XML transcript entries for Letta API
 */
export function formatAsXmlTranscript(messages: Array<{role: string, text: string}>): string {
  return messages.map(m => {
    const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'claude_code' : 'system';
    // Escape XML special chars in text
    const escaped = m.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<message role="${role}">\n${escaped}\n</message>`;
  }).join('\n');
}
