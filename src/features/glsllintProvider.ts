'use strict';
import * as cp from 'child_process';

import * as vscode from 'vscode';

const LINT_OK = 0;
const LINT_ERROR = 1;
const LINT_NO_ENTRY_POINT_WARNING = 2;


export default class GLSLLintingProvider implements vscode.CodeActionProvider {
  private static commandId: string = 'shaderclint.runCodeAction';
  private command: vscode.Disposable;
  private diagnosticCollection: vscode.DiagnosticCollection;
  private storagePath: string = undefined;
  private textChangeLintQueued: vscode.TextDocument = undefined;
  private textChangeLintInProgress: boolean = false;
  
  private extensions: Array<string> = ['.frag', '.vert'];
  
  private includers: {[key: string]: Array<string>} = {};

  private scanFileForIncludes (scanFilePath: string): any {
    let fs = require("fs");
    let readline = require("readline");
    //console.log("scanning: " + scanFilePath);
    this.includers[scanFilePath] = [];
    let lineReader = readline.createInterface({
      input: fs.createReadStream(scanFilePath)
    });
    lineReader.on('line', line=> {
      let matches = line.match(/#include\s*"(.*)"/);
      if (matches && matches.length === 2) 
      {
        let filepath = matches[1];
        this.includers[scanFilePath].push(filepath);
      }
    });
  }
  
  private findGLSLFiles (callback: (output: Array<string>) => any): any {
    let filePaths: Array<string> = [];

    vscode.workspace.textDocuments.forEach(document => {
      if(document.languageId === "glsl")
      {
        filePaths.push(document.uri.fsPath);
      }
    });

    let countExpected = this.extensions.length;
    this.extensions.forEach(extension => {
      vscode.workspace.findFiles('**/*' + extension).then(
        files => { 
          files.forEach( uri => {
            let filePath = uri.fsPath;
            if(!filePaths.find(thisResult => thisResult === filePath)) {
              filePaths.push(uri.fsPath);
            }
          });
          countExpected--;
          if(countExpected === 0) {
            callback(filePaths);
          }
        },
        notfound => {
          countExpected--;
          if(countExpected === 0) {
            callback(filePaths);
          }
        }
      );
    });
  }

  public activate (subscriptions: vscode.Disposable[], storagePath_: string|undefined) {
    this.storagePath = storagePath_;
    
    if(this.storagePath) {
      let fs = require("fs");
      fs.mkdir(this.storagePath, { recursive: true }, (err) => {
      });
    }

    this.findGLSLFiles( files => {
      files.forEach( filePath => {
        this.scanFileForIncludes(filePath);
      });

      vscode.workspace.textDocuments.forEach(this.documentOpened, this);
      this.documentModified(vscode.window.activeTextEditor.document);
    });
    
    let buildCommand = vscode.commands.registerCommand('shaderc-lint.build', () => {
      let document = vscode.window.activeTextEditor.document;
      if(document.languageId === "glsl")
      {
        document.save();
        this.compileAndLint(document, true, true);
      }
    });
    subscriptions.push(buildCommand);

    let buildAllCommand = vscode.commands.registerCommand('shaderc-lint.buildAll', () => {
      vscode.workspace.textDocuments.forEach(document => {
        if(document.languageId === "glsl")
        {
          document.save();
        }
      });

      this.findGLSLFiles( paths => {
        let saved: Array<string> = [];
        let failed: Array<string> = [];
        this.compileFiles(paths, saved, failed, () => {
          if(saved.length > 0) {
            let message: string = '✅ Compiled ' + saved.length + " files :";
            saved.forEach(includerPath => {
              message = message + " "+ includerPath.replace(/^.*[\\\/]/, '');
            });
            vscode.window.showInformationMessage(message);
          }
          if(failed.length > 0) {
            let message: string = 'Failed to compile ' + failed.length + " files :";
            failed.forEach(includerPath => {
              message = message + " "+ includerPath.replace(/^.*[\\\/]/, '');
            });
            vscode.window.showErrorMessage(message);
          }
        });
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
    vscode.workspace.onDidChangeTextDocument(this.documentModifiedEvent, this);

  }

  public dispose (): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.command.dispose();
  }

  private documentOpened (textDocument: vscode.TextDocument): any {
    if(textDocument.languageId === "glsl")
    {
      this.scanFileForIncludes(textDocument.uri.fsPath);
      this.compileAndLint(textDocument, false, false);
    }
  }

  private documentSaved (textDocument: vscode.TextDocument): any {
    if(textDocument.languageId === "glsl")
    {
      this.scanFileForIncludes(textDocument.uri.fsPath);
      this.compileAndLint(textDocument, false, true);
    }
  }

  private writeToTmpFileCompileAndLint(textDocument: vscode.TextDocument)
  {
    this.textChangeLintInProgress = true;
    let tempFilePath = this.storagePath + "/tmpFile." + textDocument.uri.fsPath.split('.').pop();
    let fs = require("fs");
    fs.writeFile(tempFilePath, textDocument.getText(), (err) => {
      const path = require('path');
      let addionalIncludePath = path.dirname(textDocument.uri.fsPath);
      this.compile(tempFilePath, addionalIncludePath, false, (output) => {
        let inputFilename = tempFilePath.replace(/^.*[\\\/]/, '');
        try {
          this.doLint(textDocument, inputFilename, output);
        }
        catch(err) {console.log("linting failed:" + err);}
        if(this.textChangeLintQueued) {
          let queuedDocuemnt: vscode.TextDocument = this.textChangeLintQueued;
          this.textChangeLintQueued = undefined;
          this.writeToTmpFileCompileAndLint(queuedDocuemnt);
        }
        else {
          this.textChangeLintInProgress = false;
        }
      });
    });
  }

  private documentModified(textDocument: vscode.TextDocument)
  {
    if(textDocument) {
      const config = vscode.workspace.getConfiguration('shaderc-lint');
      if(!config.requireSaveToLint)
      {
        if(textDocument.languageId === "glsl" && this.storagePath)
        {
          if(this.textChangeLintInProgress) {
            this.textChangeLintQueued = textDocument;
          }
          else {
            this.writeToTmpFileCompileAndLint(textDocument);
          }
        }
      }
    }
  }
  
  private documentModifiedEvent (changeEvent: vscode.TextDocumentChangeEvent): any {
    this.documentModified(changeEvent.document);
  }

  private compile(inputFilePath: string, additionalIncludeDir: string, saveOutput: boolean, callback: (output: string) => any)
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

    if(config.shadercOutputDir !== null && config.shadercOutputDir !== "") {
      outputFilePath = config.shadercOutputDir + "/" + outputFileName;
    }
    if(!saveOutput){
      outputFilePath = "-";
    }
    
    let args = config.glslcArgs.split(/\s+/).filter(arg => arg);
    args.push(inputFilePath);

    if(additionalIncludeDir){
      args.push("-I", additionalIncludeDir);
    }
    
    if(config.defaultGLSLVersion !== null && config.defaultGLSLVersion !== "") {
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

  private recursivelyFindIncluders(filename: string, result: Array<string>) : any
  {
    Object.keys(this.includers).forEach(includerFilePath=> {
      this.includers[includerFilePath].forEach(included => {
        if(filename.includes(included))
        {
          if(!result.find(thisResult => thisResult === includerFilePath)) {
            result.push(includerFilePath);
            this.recursivelyFindIncluders(includerFilePath, result);
          }
        }
      });
    });
    
  }
  
  private compileFiles(filenames: Array<string>, savedFiles: Array<string>, failedFiles: Array<string>, callback: () => any)
  {
    let remainingCount = filenames.length;
    filenames.forEach(filepath => {
      let saveOutput: boolean = true;
      this.compile(filepath, undefined, saveOutput, output=> {
        let lines = output.split(/(?:\r\n|\r|\n)/g);
        let foundError = false;
        let foundMissingEntryPoint = false;
        lines.forEach(line => {
          if (line.includes('error:')) {
            if(line.includes('Missing entry point')) {
              foundMissingEntryPoint = true;
            }
            foundError = true;
          }
        });

        if(foundError) {
          if(!foundMissingEntryPoint) {
            failedFiles.push(filepath);
          }
          else {
            const config = vscode.workspace.getConfiguration('shaderc-lint');
            if(!config.includeSupport) {
              failedFiles.push(filepath);
            }
          }
        }
        else {
          savedFiles.push(filepath);
        }
        remainingCount--;
        if(remainingCount === 0)
        {
          callback();
        }
      });
    });
  }

  private compileIncluders(filename: string, savedIncluders: Array<string>, failedIncluders: Array<string>, callback: () => any)
  {
    let recompileFilenames: Array<string> = [];
    this.recursivelyFindIncluders(filename, recompileFilenames);
    
    this.compileFiles(recompileFilenames, savedIncluders, failedIncluders, callback);
  }

  private compileAndLint(textDocument: vscode.TextDocument, saveOutputEvenIfNotConfigured: boolean, saveOutputIfConfigured: boolean)
  {
    const config = vscode.workspace.getConfiguration('shaderc-lint');
    let saveOutput = saveOutputEvenIfNotConfigured || (saveOutputIfConfigured && config.buildOnSave);
    this.compile(textDocument.fileName, undefined, saveOutput, output=> {
      let inputFilename = textDocument.fileName.replace(/^.*[\\\/]/, '');
      let result: number = this.doLint(textDocument, inputFilename, output);
      
      if(saveOutput) {
        let compileIncluders: boolean = false;
        if(result !== LINT_OK) {
          if(result === LINT_NO_ENTRY_POINT_WARNING) {
            vscode.window.showInformationMessage('✅ OK with no entry point: ' + inputFilename);
            compileIncluders = true;
          }
          else {
            vscode.window.showErrorMessage('Compile failed: ' + inputFilename);
          }
        }
        else {
          vscode.window.showInformationMessage('✅ Compiled ' + inputFilename + ".spv");
          compileIncluders = true;
        }
        if(compileIncluders) {
          let savedIncluders = [];
          let failedIncluders = [];
          this.compileIncluders(textDocument.fileName, savedIncluders, failedIncluders, () => {
            if(savedIncluders.length > 0) {
              let message: string = '✅ Compiled ' + savedIncluders.length + " files which #included " + inputFilename + ":";
              savedIncluders.forEach(includerPath => {
                message = message + " "+ includerPath.replace(/^.*[\\\/]/, '');
              });
              vscode.window.showInformationMessage(message);
            }
            if(failedIncluders.length > 0) {
              let message: string = 'Failed to compile ' + failedIncluders.length + " files which #included " + inputFilename + ":";
              failedIncluders.forEach(includerPath => {
                message = message + " "+ includerPath.replace(/^.*[\\\/]/, '');
              });
              vscode.window.showErrorMessage(message);
            }
          });
        }
      }
    });
  }

  private doLint (textDocument: vscode.TextDocument, inputFilename: string, compiledOutput: string): number {
    const config = vscode.workspace.getConfiguration('shaderc-lint');

    let displayedError = false;
    let includedFileWarning = false;
    
    let diagnostics: vscode.Diagnostic[] = [];
    let lines = compiledOutput.split(/(?:\r\n|\r|\n)/g);
    let foundMessage = (lines.length > 1 || (lines.length > 0 && lines[0] !== ""));
    let foundError = false;

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
          let message = undefined;
          let errorline = 0;
          if(matches) {
            message = matches[4];
            errorline = parseInt(matches[2]);
          }
          else {
            matches = line.match(/(.+): (error|warning):.*:(\d+):.*:\W*(.+)/);
            if(matches) {
              message = matches[4];
              errorline = parseInt(matches[3]);
            }
          }
          if (matches && matches.length === 5) {

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
              foundError = true;
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
                foundError = true;
                includedFileWarning = true;
              }
              let diagnostic =  new vscode.Diagnostic(range, message, severity);
              diagnostics.push(diagnostic);
              displayedError = true;
              if(severity === vscode.DiagnosticSeverity.Error) {
                foundError = true;
              }
            }
          }
        }
      }
    });

    if(foundMessage && !displayedError) {
        let message = "Error:" + compiledOutput;
        let range = textDocument.lineAt(0).range;
        
        let diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
        diagnostics.push(diagnostic);
        displayedError = true;
        foundError = true;
    }

    this.diagnosticCollection.set(textDocument.uri, diagnostics);

    if(foundError) {
      if(includedFileWarning) {
        return LINT_NO_ENTRY_POINT_WARNING;
      } else {
        return LINT_ERROR;
      }
    }

    return LINT_OK;

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