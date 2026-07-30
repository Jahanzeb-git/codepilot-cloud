const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

const html = `
<!DOCTYPE html>
<html><body><div id="root"></div></body></html>
`;

const dom = new JSDOM(html, { runScripts: "dangerously" });
const window = dom.window;
const document = window.document;

global.window = window;
global.document = document;
global.HTMLElement = window.HTMLElement;
global.navigator = window.navigator;
global.Event = window.Event;
global.CustomEvent = window.CustomEvent;

// Mock vscode api
window.acquireVsCodeApi = () => ({
    postMessage: (msg) => console.log('postMessage:', msg)
});

// Load the compiled extension webview code
const code = fs.readFileSync('dist/webview.js', 'utf-8');
const script = document.createElement('script');
script.textContent = code;
document.body.appendChild(script);

// Wait for it to initialize
setTimeout(() => {
    console.log('--- Sending session_switched ---');
    const msg = {
        type: 'session_switched',
        session_id: 'session_test',
        messages: [
            { role: 'user', content: '[SYSTEM] hi' },
            { role: 'assistant', content: 'priming' },
            { role: 'user', content: '[EXECUTION RESULT] ok' },
            { role: 'assistant', content: 'priming2' },
            { role: 'user', content: '[EXECUTION RESULT] ok' },
            { role: 'user', content: '[Task 1][USER INPUT]\nHello' },
            { role: 'assistant', content: 'Hello! 👋' }
        ]
    };
    
    // Simulate postMessage
    const event = new window.Event('message');
    event.data = msg;
    window.dispatchEvent(event);

    setTimeout(() => {
        console.log('--- RESULT HTML ---');
        const container = document.getElementById('chat-container');
        console.log(container ? container.innerHTML : 'NULL');
    }, 100);
}, 100);
