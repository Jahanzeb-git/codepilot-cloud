export type ParsedStreamEvent =
    | { kind: 'text'; text: string }
    | { kind: 'thinking_start' }
    | { kind: 'thinking_end' };

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';
const TAG_RE = /<\/?thinking>/;

/**
 * Feeds raw stream chunks in and emits safe, complete events out.
 * Crucially: never emits text that might contain half of a <thinking> tag,
 * by holding back any trailing fragment that could still turn into a full
 * tag once the next chunk arrives. This is what the original implementation
 * was missing — it string-matched on each chunk independently, which breaks
 * the moment a tag is split across a network/socket boundary.
 */
export class TagAwareStreamParser {
    private pending = '';

    public feed(chunk: string): ParsedStreamEvent[] {
        this.pending += chunk;
        const events: ParsedStreamEvent[] = [];
        let buf = this.pending;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const match = TAG_RE.exec(buf);
            if (match) {
                const before = buf.slice(0, match.index);
                if (before.length > 0) {
                    events.push({ kind: 'text', text: before });
                }
                events.push({ kind: match[0] === OPEN_TAG ? 'thinking_start' : 'thinking_end' });
                buf = buf.slice(match.index + match[0].length);
                continue;
            }
            break;
        }

        // No more complete tags left in buf. Check whether the tail could be
        // the start of a tag that just hasn't fully arrived yet.
        const lastLt = buf.lastIndexOf('<');
        if (lastLt !== -1) {
            const tail = buf.slice(lastLt);
            if (OPEN_TAG.startsWith(tail) || CLOSE_TAG.startsWith(tail)) {
                const safeText = buf.slice(0, lastLt);
                if (safeText.length > 0) {
                    events.push({ kind: 'text', text: safeText });
                }
                this.pending = tail;
                return events;
            }
        }

        if (buf.length > 0) {
            events.push({ kind: 'text', text: buf });
        }
        this.pending = '';
        return events;
    }
}