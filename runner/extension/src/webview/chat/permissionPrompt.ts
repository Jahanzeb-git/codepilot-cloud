export function renderPermissionPrompt(
    container: HTMLElement,
    tool: string,
    description: string,
    onRespond: (allowed: boolean) => void
): void {
    const wrap = document.createElement('div');
    wrap.className = 'permission-prompt';
    wrap.tabIndex = -1;

    const text = document.createElement('div');
    text.className = 'permission-prompt-text';
    text.textContent = description || `CodePilot wants to run "${tool}". Allow?`;

    const actions = document.createElement('div');
    actions.className = 'permission-prompt-actions';

    const allowBtn = document.createElement('button');
    allowBtn.className = 'btn btn-primary';
    allowBtn.innerHTML = `Allow <span class="kbd-hint">Alt+Enter</span>`;

    const denyBtn = document.createElement('button');
    denyBtn.className = 'btn btn-secondary';
    denyBtn.innerHTML = `Reject <span class="kbd-hint">Alt+R</span>`;

    let resolved = false;
    const respond = (allowed: boolean) => {
        if (resolved) return;
        resolved = true;
        document.removeEventListener('keydown', onKeydown, true);
        onRespond(allowed);
        wrap.remove();
    };

    const onKeydown = (e: KeyboardEvent) => {
        if (!e.altKey) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            respond(true);
        } else if (e.key.toLowerCase() === 'r') {
            e.preventDefault();
            respond(false);
        }
    };
    // Captured at document level (not just on wrap) so the shortcut works
    // regardless of where focus currently sits in the panel.
    document.addEventListener('keydown', onKeydown, true);

    allowBtn.onclick = () => respond(true);
    denyBtn.onclick = () => respond(false);

    actions.appendChild(allowBtn);
    actions.appendChild(denyBtn);
    wrap.appendChild(text);
    wrap.appendChild(actions);
    container.appendChild(wrap);
    wrap.scrollIntoView({ block: 'nearest' });
}