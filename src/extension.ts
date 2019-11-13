'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';


import GLSLLintingProvider from './features/glsllintProvider';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    let linter = new GLSLLintingProvider();
    let storagePath = context.storagePath;
    if (!storagePath) {
        storagePath = context.logPath; //this is really icky, but when there is no workspace there is no storagePath, and no other path seems suitable, so we'll store tmp files in the log location.
    }

    linter.activate(context.subscriptions, storagePath);
    vscode.languages.registerCodeActionsProvider({ scheme: 'file', language: 'glsl' }, linter);
}



// this method is called when your extension is deactivated
export function deactivate() {
}