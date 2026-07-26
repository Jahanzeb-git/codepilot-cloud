export function mountTopBar(
    container: HTMLElement,
    onOpenSessions: () => void,
    onOpenSettings: () => void
): void {
    const bar = document.createElement('div');
    bar.id = 'top-bar';
    bar.innerHTML = `
        <span id="top-bar-title">CodePilot</span>
        <div id="top-bar-actions">
            <button id="sessions-btn" class="topbar-icon-btn" title="Sessions" aria-label="Sessions">
                <svg viewBox="0 0 16 16" width="15" height="15">
                    <rect x="2" y="3" width="12" height="2.2" rx="1" fill="currentColor"/>
                    <rect x="2" y="7" width="12" height="2.2" rx="1" fill="currentColor"/>
                    <rect x="2" y="11" width="8" height="2.2" rx="1" fill="currentColor"/>
                </svg>
            </button>
            <button id="settings-btn" class="topbar-icon-btn" title="Settings" aria-label="Settings">
                <svg viewBox="0 0 16 16" width="15" height="15">
                    <path fill="currentColor" d="M8 5a3 3 0 100 6 3 3 0 000-6zm6.4 3a5.9 5.9 0 00-.1-1.1l1.4-1.1-1.3-2.3-1.7.5a5.9 5.9 0 00-1.9-1.1L10.4 1H8.6L8.2 2.9a5.9 5.9 0 00-1.9 1.1l-1.7-.5-1.3 2.3L4.7 6.9A5.9 5.9 0 004.6 8c0 .4 0 .7.1 1.1L3.3 10.2l1.3 2.3 1.7-.5c.6.5 1.2.9 1.9 1.1L8.6 15h1.8l.4-1.9c.7-.2 1.3-.6 1.9-1.1l1.7.5 1.3-2.3-1.4-1.1c.1-.4.1-.7.1-1.1z"/>
                </svg>
            </button>
        </div>
    `;
    container.prepend(bar);

    bar.querySelector('#sessions-btn')!.addEventListener('click', onOpenSessions);
    bar.querySelector('#settings-btn')!.addEventListener('click', onOpenSettings);
}