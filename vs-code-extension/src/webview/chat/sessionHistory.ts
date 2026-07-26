import { AgentMessageView } from './agentMessageView';

interface TranscriptMessage {
    role: string;
    content: string;
}

// The library's first N messages are few-shot priming turns (system-setup,
// environment verification) that were never actually generated live — skip
// them per the session JSON structure you shared.
const PRIMING_MESSAGE_COUNT = 5;

const TOOL_CALL_RE = /```codepilot\s*\n([\s\S]*?)```/g;
const CALL_PATTERN_RE = /(\w+)\(/;

function extractToolName(codeBlock: string): string | null {
    const match = CALL_PATTERN_RE.exec(codeBlock.trim());
    if (!match) return null;
    const tool = match[1];
    if (tool === 'task') return null; // finish markers aren't a user-facing tool call
    return tool;
}

function stripUserPrefix(content: string): { text: string; isSystemNoise: boolean } {
    if (content.startsWith('[SYSTEM]') || content.startsWith('[EXECUTION RESULT]')) {
        return { text: '', isSystemNoise: true };
    }
    const taskInputMatch = content.match(/^\[Task \d+\]\[USER INPUT\]\n([\s\S]*)$/);
    if (taskInputMatch) {
        return { text: taskInputMatch[1], isSystemNoise: false };
    }
    return { text: content, isSystemNoise: false };
}

export function renderSessionHistory(chatContainer: HTMLElement, messages: TranscriptMessage[]): void {
    chatContainer.innerHTML = '';
    const real = messages.slice(PRIMING_MESSAGE_COUNT);

    for (const msg of real) {
        if (msg.role === 'user') {
            const { text, isSystemNoise } = stripUserPrefix(msg.content);
            if (isSystemNoise || !text.trim()) continue;

            const div = document.createElement('div');
            div.className = 'message user-message';
            div.textContent = text;
            chatContainer.appendChild(div);
            continue;
        }

        if (msg.role === 'assistant') {
            const toolNames: string[] = [];
            let match: RegExpExecArray | null;
            TOOL_CALL_RE.lastIndex = 0;
            while ((match = TOOL_CALL_RE.exec(msg.content)) !== null) {
                const tool = extractToolName(match[1]);
                if (tool) toolNames.push(tool);
            }

            const isBlank = !msg.content.trim() && toolNames.length === 0;
            if (isBlank) continue;

            const view = new AgentMessageView(chatContainer, true);
            if (msg.content) {
                view.pushChunk(msg.content);
            }
            for (const tool of toolNames) {
                view.addToolCall(tool, {}, `Completed ${tool}`);
                view.resolveToolCall(tool, '');
            }
            view.finish();
        }
    }

    chatContainer.scrollTop = chatContainer.scrollHeight;
}