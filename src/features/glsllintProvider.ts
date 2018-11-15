'use strict';
import * as cp from 'child_process';

import * as vscode from 'vscode';

export default class GLSLLintingProvider implements vscode.CodeActionProvider {
  private static commandId: string = 'glsllint.runCodeAction';
  private command: vscode.Disposable;
  private diagnosticCollection: vscode.DiagnosticCollection;

  public activate (subscriptions: vscode.Disposable[]) {
    this.command = vscode.commands.registerCommand(
      GLSLLintingProvider.commandId, this.runCodeAction, this);
    subscriptions.push(this);
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection();

    vscode.workspace.onDidOpenTextDocument(this.doLint, this, subscriptions);
    vscode.workspace.onDidCloseTextDocument((textDocument) => {
      this.diagnosticCollection.delete(textDocument.uri);
    }, null, subscriptions);

    vscode.workspace.onDidSaveTextDocument(this.doLint, this);

    vscode.workspace.textDocuments.forEach(this.doLint, this);
  }

  public dispose (): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.command.dispose();
  }

  private doLint (textDocument: vscode.TextDocument): any {
    if (textDocument.languageId !== 'glsl') {
      return;
    }

    const config = vscode.workspace.getConfiguration('shaderc-lint');
    // The code you place here will be executed every time your command is
    // executed
    if (config.glslcPath === null ||
      config.glslcPath === '') {
      vscode.window.showErrorMessage(
        'Shaderc Lint: config.glslcPath is empty, please set it to the executable');
      return;
    }

    let decoded = '';
    let diagnostics: vscode.Diagnostic[] = [];

    let args = config.glslcArgs.split(/\s+/).filter(arg => arg);
    args.push(textDocument.fileName);


    let inputFilePath = textDocument.fileName;
    let inputFilename = inputFilePath.replace(/^.*[\\\/]/, '');

    let outputFilePath = inputFilePath + ".spv";
    let outputFileName = inputFilename + ".spv";

    if(!config.outputSPV)
    {
      console.log("no output generated");
      outputFilePath = "-";
    }
    else if(config.shadercOutputDir !== null && config.shadercOutputDir !== "")
    {
      outputFilePath = config.shadercOutputDir + "/" + outputFileName;
    }
    
    
    if(config.defaultGLSLVersion !== null && config.defaultGLSLVersion !== "")
    {
      args.push("-std=" + config.defaultGLSLVersion);
    }
    
    args.push("-o");
    args.push(outputFilePath);
    console.log(args);
    

    let options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } :
      undefined;

    let childProcess = cp.spawn(config.glslcPath, args, options);
    if (childProcess.pid) {
      childProcess.stderr.on('data', (data) => { decoded += data; });
      childProcess.stdout.on('end', () => {
    
        let lines = decoded.toString().split(/(?:\r\n|\r|\n)/g);
        let foundError = (lines.length > 1 || (lines.length > 0 && lines[0] !== ""));
        let displayedError = false;
        
      //console.log(decoded);

        lines.forEach(line => {
          if (line !== '') {
            let severity: vscode.DiagnosticSeverity = undefined;

            if (line.includes('error:')) {
              severity = vscode.DiagnosticSeverity.Error;
            }
            if (line.includes('warning:')) {
              severity = vscode.DiagnosticSeverity.Warning;
            }

            if (severity !== undefined) 
            {
              let matches = line.match(/(.+):(\d+):\W(error|warning):(.+)/);
              if (matches && matches.length === 5) 
              {
                let message = matches[4];
                let errorline = parseInt(matches[2]);

                let range = null;

                if(line.includes(inputFilename))
                {
                  let docLine = textDocument.lineAt(errorline - 1);
                  range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
                }
                else
                {
                  let includeFound = false;
                  let includeFilename = matches[1].replace(/^.*[\\\/]/, '');
                  if(includeFilename)
                  {
                    for(let i = 0; i < textDocument.lineCount; i++)
                    {
                      let docLine = textDocument.lineAt(i);
                      if(docLine.text.includes(includeFilename) && docLine.text.includes("#include"))
                      {
                        includeFound = true;
                        range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
                        break;
                      }
                    }
                  }
                  if(!includeFound)
                  {
                    let docLine = textDocument.lineAt(0);
                    range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
                  }

                }

                let diagnostic = new vscode.Diagnostic(range, message, severity);
                diagnostics.push(diagnostic);
                displayedError = true;
              } 
              else 
              {
                let matches = line.match(/.+:\W(error|warning):(.+)/);
                if (matches && matches.length === 3) 
                {
                  let message = matches[2];
                  let docLine = textDocument.lineAt(0);
                  let range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
                  
                  if (config.includeSupport && line.includes('Missing entry point')) 
                  {
                    severity = vscode.DiagnosticSeverity.Warning;
                    message = "Missing entry point. No .spv file was generated, but you can ignore this warning if this file is mant to be #included elsewhere.";
                  }
                  let diagnostic =  new vscode.Diagnostic(range, message, severity);
                  diagnostics.push(diagnostic);
                  displayedError = true;

                }
              }
            }
          }
        });
        
        if(foundError && !displayedError)
        {
          let message = "Error:" + decoded.toString();
          let range = textDocument.lineAt(0).range;
          console.log(decoded.toString());
          
          let diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
          diagnostics.push(diagnostic);
        }

        this.diagnosticCollection.set(textDocument.uri, diagnostics);
      });
    }
  }

  public provideCodeActions (
    document: vscode.TextDocument, range: vscode.Range,
    context: vscode.CodeActionContext, token: vscode.CancellationToken):
    vscode.ProviderResult<vscode.Command[]> {
    throw new Error('Method not implemented.');
  }

  private runCodeAction (
    document: vscode.TextDocument, range: vscode.Range,
    message: string): any {
    throw new Error('Method not implemented.');
  }
}