const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const extensionConfig = {
  target: 'node',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules|src[\\/]webview/,
        use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.json' } }]
      }
    ]
  },
  devtool: 'nosources-source-map'
};

// Both webview bundles (chat panel + terminal panel) run in a browser-like
// context inside the VS Code webview iframe, so they get their own config
// with target 'web' and the DOM-aware tsconfig.
const webviewConfig = {
  target: 'web',
  entry: {
    chat: './src/webview/chat/main.ts',
    terminal: './src/webview/terminal/main.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist', 'webview'),
    filename: '[name].js'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        include: /src[\\/]webview/,
        use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.webview.json' } }]
      },
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader']
      }
    ]
  },
  plugins: [
    new MiniCssExtractPlugin({ filename: '[name].css' }),
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'node_modules/xterm/css/xterm.css'),
          to: path.resolve(__dirname, 'dist', 'webview', 'xterm.css')
        },
        {
          from: path.resolve(__dirname, 'node_modules/highlight.js/styles/github-dark.css'),
          to: path.resolve(__dirname, 'dist', 'webview', 'hljs-theme.css')
        }
      ]
    })
  ],
  devtool: 'nosources-source-map'
};

module.exports = [extensionConfig, webviewConfig];