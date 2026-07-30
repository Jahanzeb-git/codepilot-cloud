const fs = require('fs');
const content = fs.readFileSync('runner/extension/src/terminalPanel.ts', 'utf8');

// 1. Add ctrlReconnectTimer to the class properties
let newContent = content.replace(
    'private ctrlConnecting = false;',
    'private ctrlConnecting = false;\n    private ctrlReconnectTimer: NodeJS.Timeout | null = null;'
);

// 2. Update connectControl's close handler to store the timer
newContent = newContent.replace(
    /setTimeout\(\(\) => this\.connectControl\(\), CTRL_RECONNECT_MS\);/g,
    'this.ctrlReconnectTimer = setTimeout(() => this.connectControl(), CTRL_RECONNECT_MS);'
);

// 3. Update the fs.watch handler to clear the timer
newContent = newContent.replace(
    /\/\/ The close event will trigger a delayed reconnect, but we want it fast:/g,
    '// Clear the delayed reconnect timer and do it fast:\n                            if (this.ctrlReconnectTimer) clearTimeout(this.ctrlReconnectTimer);\n                            this.ctrlReconnectTimer = setTimeout(() => this.connectControl(), 100);'
);

// 4. Update connectControl start to clear any existing timer
newContent = newContent.replace(
    /this\.ctrlConnecting = true;/g,
    'this.ctrlConnecting = true;\n        if (this.ctrlReconnectTimer) {\n            clearTimeout(this.ctrlReconnectTimer);\n            this.ctrlReconnectTimer = null;\n        }'
);

fs.writeFileSync('runner/extension/src/terminalPanel.ts', newContent);
