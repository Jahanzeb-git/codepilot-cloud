import { vscode } from './vscodeApi';
import { SessionSummary } from './types';

const TITLE_MAX_LEN = 48;

function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

function formatRelativeTime(unixSeconds: number): string {
    const diffMs = Date.now() - unixSeconds * 1000;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export function showSessionModal(sessions: SessionSummary[], currentSessionId: string | null): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<span>Sessions</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-btn';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);

    const newBtn = document.createElement('button');
    newBtn.className = 'btn btn-primary modal-new-session-btn';
    newBtn.textContent = '+ New Session';
    newBtn.onclick = () => {
        vscode.postMessage({ type: 'new_session' });
        overlay.remove();
    };

    const list = document.createElement('div');
    list.className = 'session-list';

    if (sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'session-list-empty';
        empty.textContent = 'No previous sessions yet.';
        list.appendChild(empty);
    }

    for (const s of sessions) {
        const item = document.createElement('div');
        item.className = 'session-item' + (s.session_id === currentSessionId ? ' active' : '');

        const title = document.createElement('div');
        title.className = 'session-item-title';
        title.textContent = truncate(s.title || '(untitled session)', TITLE_MAX_LEN);

        const meta = document.createElement('div');
        meta.className = 'session-item-meta';
        meta.textContent = formatRelativeTime(s.updated_at);

        item.appendChild(title);
        item.appendChild(meta);
        item.onclick = () => {
            vscode.postMessage({ type: 'switch_session', session_id: s.session_id });
            overlay.remove();
        };
        list.appendChild(item);
    }

    modal.appendChild(header);
    modal.appendChild(newBtn);
    modal.appendChild(list);
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
}