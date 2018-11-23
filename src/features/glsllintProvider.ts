'use strict';
import * as cp from 'child_process';

import * as vscode from 'vscode';




export default class GLSLLintingProvider implements vscode.CodeActionProvider {
  private static commandId: string = 'glsllint.runCodeAction';
  private command: vscode.Disposable;
  private diagnosticCollection: vscode.DiagnosticCollection;
  
  private includers: {[key: string]: Array<string>} = {};

  private scanFileForIncludes (uri: vscode.Uri): any {
    let fs = require("fs");
    let readline = require("readline");
    //console.log("scsanning: " + uri.path);
    this.includers[uri.fsPath] = [];
    let lineReader = readline.createInterface({
      input: fs.createReadStream(uri.fsPath)
    });
    lineReader.on('line', line=> {
      let matches = line.match(/#include\s*"(.*)"/);
      if (matches && matches.length === 2) 
      {
        let filepath = matches[1];
        this.includers[uri.fsPath].push(filepath);
      }
    });
  }

  public activate (subscriptions: vscode.Disposable[]) {

    
    vscode.workspace.findFiles('*.{frag,vert}').then(
      files => { 
        files.forEach( uri => {
          this.scanFileForIncludes(uri);
        });
      }
    );
    
    let buildCommand = vscode.commands.registerCommand('shaderc-lint.build', () => {
      let document = vscode.window.activeTextEditor.document;
      document.save();
      this.doLint(document, true, true);
    });
    subscriptions.push(buildCommand);

   let buildAllCommand = vscode.commands.registerCommand('shaderc-lint.buildAll', () => {
    vscode.workspace.textDocuments.forEach(document => {
       if(document.languageId === "glsl")
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

    vscode.workspace.onDidOpenTextDocument(this.documentOpened, this, subscriptions);

    vscode.workspace.onDidCloseTextDocument((textDocument) => {
      this.diagnosticCollection.delete(textDocument.uri);
    }, null, subscriptions);

    vscode.workspace.onDidSaveTextDocument(this.documentSaved, this);

    vscode.workspace.textDocuments.forEach(this.documentOpened, this);
  }

  public dispose (): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.command.dispose();
  }
  private documentOpened (textDocument: vscode.TextDocument): any {
    this.doLint(textDocument, false, false);
  }
  private documentSaved (textDocument: vscode.TextDocument): any {
    
    if(textDocument.languageId === "glsl")
    {
      this.scanFileForIncludes(textDocument.uri);

      const config = vscode.workspace.getConfiguration('shaderc-lint');
      if(config.buildAllOnSave)
      {
        vscode.workspace.textDocuments.forEach(document => {
          if(document.languageId === "glsl")
          {
            document.save();
            this.doLint(document, true, true);
          }
        });
      }
      else
      {
        this.doLint(textDocument, false, true);
      }
    }
  }

  private compile(inputFilePath: string, saveOutput: boolean, callback: (output: string) => any)
  {
    const config = vscode.workspace.getConfiguration('shaderc-lint');
    if (config.glslcPath === null ||
      config.glslcPath === '') {
        vscode.window.showErrorMessage(
          'Shaderc Lint: config.glslcPath is empty, please set it to the executable');
      return;
    }
    
    let inputFilename = inputFilePath.replace(/^.*[\\\/]/, '');

    let outputFilePath = inputFilePath + ".spv";
    let outputFileName = inputFilename + ".spv";

    if(config.shadercOutputDir !== null && config.shadercOutputDir !== "")
    {
      outputFilePath = config.shadercOutputDir + "/" + outputFileName;
    }
    if(!saveOutput)
    {
      outputFilePath = "-";
    }
    
    let args = config.glslcArgs.split(/\s+/).filter(arg => arg);
    args.push(inputFilePath);
    
    if(config.defaultGLSLVersion !== null && config.defaultGLSLVersion !== "")
    {
      args.push("-std=" + config.defaultGLSLVersion);
    }
    
    args.push("-o");
    args.push(outputFilePath);

    let options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } :
      undefined;

      let shadercOutput = '';

    let childProcess = cp.spawn(config.glslcPath, args, options);
    if (childProcess.pid) {
      childProcess.stderr.on('data', (data) => { shadercOutput += data; });
      childProcess.stdout.on('end', () => {
        callback(shadercOutput.toString());
      });
    }
    
  }

  private recursivelyCompileIncluders(filename: string, savedIncluders: Array<string>, failedIncluders: Array<string>, callback: () => any) //todo not recursive yet, doesn't support #includes in #includes
  {
    let recompileFilenames = [];
    Object.keys(this.includers).forEach(includerFilePath=> {
      this.includers[includerFilePath].forEach(included => {
        if(filename.includes(included))
        {
          recompileFilenames.push(includerFilePath);
        }
      });
    });
    let remainingCount = recompileFilenames.length;
    recompileFilenames.forEach(includerFilePath => {
      let saveOutput: boolean = true;
      this.compile(includerFilePath, saveOutput, output=> { //todo - if document is open, lint it
        let lines = output.split(/(?:\r\n|\r|\n)/g);
        let foundError = false;
        lines.forEach(line => {
          if (line.includes('error:') && !line.includes('Missing entry point')) {
            foundError = true;
          }
        });

        if(foundError) {
          failedIncluders.push(includerFilePath);
        }
        else {
          savedIncluders.push(includerFilePath);
        }
        remainingCount--;
        if(remainingCount === 0)
        {
          callback();
        }
      });
    });
  }

  private doLint (textDocument: vscode.TextDocument, saveOutputEvenIfNotConfigured: boolean, saveOutputIfConfigured: boolean): any {
    if (textDocument.languageId !== 'glsl') {
      return;
    }

    const config = vscode.workspace.getConfiguration('shaderc-lint');
    let saveOutput = saveOutputEvenIfNotConfigured || (saveOutputIfConfigured && (config.buildOnSave || config.buildAllOnSave));

    this.compile(textDocument.fileName, saveOutput, output=> {
      let displayedError = false;
      let includedFileWarning = false;
      
      let diagnostics: vscode.Diagnostic[] = [];
      let inputFilename = textDocument.fileName.replace(/^.*[\\\/]/, '');
      let savedSPVFile = saveOutput;
  
      let lines = output.split(/(?:\r\n|\r|\n)/g);
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

          if (severity !== undefined) {
            let matches = line.match(/(.+):(\d+):\W(error|warning):(.+)/);
            if (matches && matches.length === 5) {
              let message = matches[4];
              let errorline = parseInt(matches[2]);

              let range = null;

              if(line.includes(inputFilename)) {
                let docLine = textDocument.lineAt(errorline - 1);
                range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
              }
              else {
                let includeFound = false;
                let includeFilename = matches[1].replace(/^.*[\\\/]/, '');
                if(includeFilename) {
                  for(let i = 0; i < textDocument.lineCount; i++) {
                    let docLine = textDocument.lineAt(i);
                    if(docLine.text.includes(includeFilename) && docLine.text.includes("#include")) {
                      includeFound = true;
                      range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
                      break;
                    }
                  }
                }
                if(!includeFound) {
                  let docLine = textDocument.lineAt(0);
                  range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
                }
              }

              let diagnostic = new vscode.Diagnostic(range, message, severity);
              diagnostics.push(diagnostic);
              displayedError = true;
              
              if(severity === vscode.DiagnosticSeverity.Error) {
                savedSPVFile = false;
              }
            } 
            else {
              let matches = line.match(/.+:\W(error|warning):(.+)/);
              if (matches && matches.length === 3) {
                let message = matches[2];
                let docLine = textDocument.lineAt(0);
                let range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
                
                if (config.includeSupport && line.includes('Missing entry point')) {
                  severity = vscode.DiagnosticSeverity.Warning;
                  message = "Missing entry point. No .spv file was generated, but you can ignore this warning if this file is meant to be #included elsewhere.";
                  savedSPVFile = false;
                  includedFileWarning = true;
                }
                let diagnostic =  new vscode.Diagnostic(range, message, severity);
                diagnostics.push(diagnostic);
                displayedError = true;
                if(severity === vscode.DiagnosticSeverity.Error) {
                  savedSPVFile = false;
                }
              }
            }
          }
        }
      });

      if(foundError && !displayedError) {
          let message = "Error:" + output;
          let range = textDocument.lineAt(0).range;
          
          let diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
          diagnostics.push(diagnostic);
          displayedError = true;
          savedSPVFile = false;
      }

      this.diagnosticCollection.set(textDocument.uri, diagnostics);

      if(saveOutput) {
        let compileIncluders: boolean = false;
        if(!savedSPVFile) {
          if(!includedFileWarning) {
            vscode.window.showErrorMessage('Compile failed: ' + inputFilename);
          }
          else {
            vscode.window.showInformationMessage('No entry point: ' + inputFilename);
            compileIncluders = true;
          }
        }
        else {
          vscode.window.showInformationMessage('✅ Saved ' + inputFilename + ".spv");
          compileIncluders = true;
        }
        if(compileIncluders) {
          let savedIncluders = [];
          let failedIncluders = [];
          this.recursivelyCompileIncluders(textDocument.fileName, savedIncluders, failedIncluders, () => {
            if(savedIncluders.length > 0) {
              vscode.window.showInformationMessage('✅ Saved ' + savedIncluders.length + " files which #included " + inputFilename);
            }
            if(failedIncluders.length > 0) {
              vscode.window.showErrorMessage('Failed to compile ' + failedIncluders.length + " files which #included " + inputFilename);
            }
          });
        }
      }
    });
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