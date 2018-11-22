'use strict';
import * as cp from 'child_process';

import * as vscode from 'vscode';

export default class GLSLLintingProvider implements vscode.CodeActionProvider {
  private static commandId: string = 'glsllint.runCodeAction';
  private command: vscode.Disposable;
  private diagnosticCollection: vscode.DiagnosticCollection;

  public activate (subscriptions: vscode.Disposable[]) {

    
    let buildCommand = vscode.commands.registerCommand('shaderc-lint.build', () => {
      let document = vscode.window.activeTextEditor.document;
      document.save();
      this.doLint(document, true, true);
    });
    subscriptions.push(buildCommand);

   let buildAllCommand = vscode.commands.registerCommand('shaderc-lint.buildAll', () => {
    vscode.workspace.textDocuments.forEach(document => {
       if(document.languageId == "glsl")
       {
        document.save();
        this.doLint(document, true, true);
       }
     });
    });
    subscriptions.push(buildAllCommand);


    this.command = vscode.commands.registerCommand(
      GLSLLintingProvider.commandId, this.runCodeAction, this);
    subscriptions.push(this);
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection();

    vscode.workspace.onDidOpenTextDocument(this.doLintWithoutSave, this, subscriptions);

    vscode.workspace.onDidChangeTextDocument(this.doLintDueToTextChange, this, subscriptions);

    vscode.workspace.onDidCloseTextDocument((textDocument) => {
      this.diagnosticCollection.delete(textDocument.uri);
    }, null, subscriptions);

    vscode.workspace.onDidSaveTextDocument(this.doLintWithSaveIfConfigured, this);

    vscode.workspace.textDocuments.forEach(this.doLintWithoutSave, this);
  }

  public dispose (): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.command.dispose();
  }
  private doLintWithoutSave (textDocument: vscode.TextDocument): any {
    this.doLint(textDocument, false, false)
  }
  private doLintWithSaveIfConfigured (textDocument: vscode.TextDocument): any {
    this.doLint(textDocument, false, true)
  }
  private doLintDueToTextChange (textDocumentChangeEvent: vscode.TextDocumentChangeEvent): any {
    //this.doLint(textDocumentChangeEvent.document, false, false) //doesn't work, because the file is not saved. Not sure how to implement
  }

  private doLint (textDocument: vscode.TextDocument, saveOutputEvenIfNotConfigured: boolean, saveOutputIfConfigured: boolean): any {
    if (textDocument.languageId !== 'glsl') {
      return;
    }

    const config = vscode.workspace.getConfiguration('shaderc-lint');
    
    if (config.glslcPath === null ||
      config.glslcPath === '') {
      vscode.window.showErrorMessage(
        'Shaderc Lint: config.glslcPath is empty, please set it to the executable');
      return;
    }

    let decoded = '';
    let diagnostics: vscode.Diagnostic[] = [];

    

    let inputFilePath = textDocument.fileName;
    let inputFilename = inputFilePath.replace(/^.*[\\\/]/, '');

    let outputFilePath = inputFilePath + ".spv";
    let outputFileName = inputFilename + ".spv";


    let args = config.glslcArgs.split(/\s+/).filter(arg => arg);
    args.push(textDocument.fileName);



    let saveOutput = saveOutputEvenIfNotConfigured || (saveOutputIfConfigured && config.outputSPVOnSave);

    if(!saveOutput)
    {
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

    let options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } :
      undefined;

    let childProcess = cp.spawn(config.glslcPath, args, options);
    if (childProcess.pid) {
      childProcess.stderr.on('data', (data) => { decoded += data; });
      childProcess.stdout.on('end', () => {
        
        let displayedError = false;
        let includedFileWarning = false;
        let savedSPVFile = saveOutput;
    
        let lines = decoded.toString().split(/(?:\r\n|\r|\n)/g);
        let foundError = (lines.length > 1 || (lines.length > 0 && lines[0] !== ""));

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
                
                if(severity === vscode.DiagnosticSeverity.Error)
                {
                  savedSPVFile = false;
                }
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
                    message = "Missing entry point. No .spv file was generated, but you can ignore this warning if this file is meant to be #included elsewhere.";
                    savedSPVFile = false;
                    includedFileWarning = true;
                  }
                  let diagnostic =  new vscode.Diagnostic(range, message, severity);
                  diagnostics.push(diagnostic);
                  displayedError = true;
                  if(severity === vscode.DiagnosticSeverity.Error)
                  {
                    savedSPVFile = false;
                  }

                }
              }
            }
          }
        });
        
        if(foundError && !displayedError)
        {
          let message = "Error:" + decoded.toString();
          let range = textDocument.lineAt(0).range;
          
          let diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
          diagnostics.push(diagnostic);
          displayedError = true;
          savedSPVFile = false;
        }

        this.diagnosticCollection.set(textDocument.uri, diagnostics);

        if(saveOutput)
        {
          if(!savedSPVFile)
          {
            if(!includedFileWarning)
            {
              vscode.window.showErrorMessage('Compile failed: ' + inputFilename);
            }
            else
            {
              vscode.window.showInformationMessage('No entry point: ' + inputFilename)
            }
          }
          else
          {
            vscode.window.showInformationMessage('✅ Saved ' + outputFileName)
          }
        }
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