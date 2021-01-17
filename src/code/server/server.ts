// Tencent is pleased to support the open source community by making LuaPanda available.
// Copyright (C) 2019 THL A29 Limited, a Tencent company. All rights reserved.
// Licensed under the BSD 3-Clause License (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at
// https://opensource.org/licenses/BSD-3-Clause
// Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

//第三方npm引用
import {
  createConnection,
  TextDocuments,
  TextDocument,
  // Diagnostic,
  // DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  SymbolInformation,
  TextDocumentPositionParams,
  DocumentSymbolParams,
  Definition, //定义跳转
  WorkspaceSymbolParams, //folder 符号
  DocumentFormattingParams,
  TextEdit,
  DocumentHighlight,
  ColorInformation,
  DocumentColorParams,
  ColorPresentationParams,
  ColorPresentation,
  // SignatureHelp,
  ReferenceParams,
  DocumentSymbol,
} from 'vscode-languageserver';
let path = require('path'); /*nodejs自带的模块*/
import * as fs from 'fs';
import * as Tools from './codeTools';
import { Logger } from './codeLogManager';
import { CodeSymbol } from './codeSymbol';
import { CodeDefinition } from './codeDefinition';
import { CodeCompletion } from './codeCompletion';
import { CodeEditor } from './codeEditor';
import { CodeFormat } from './codeFormat';
import { CodeLinting } from './codeLinting';
import { CodeReference } from './codeReference';
import { NativeCodeExportBase } from './codeExport/nativeCodeExportBase';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);
let documents: TextDocuments = new TextDocuments();
let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
// let hasDiagnosticRelatedInformationCapability: boolean = false;
let analyzerTotalSwitch: boolean = true;
// The settings
export interface LuaAnalyzerSettings {
  codeLinting: {
    enable: boolean;
    luacheckPath: string;
    luaVersion: string;
    checkWhileTyping: boolean;
    checkAfterSave: boolean;
    maxNumberOfProblems: number;
    maxLineLength: number;
    ignoreFolderRegularExpression: string;
    ignoreErrorCode: string;
    ignoreGlobal: string;
  };
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: LuaAnalyzerSettings = {
  codeLinting: {
    enable: true,
    luacheckPath: '',
    luaVersion: '5.1',
    checkWhileTyping: true,
    checkAfterSave: true,
    maxNumberOfProblems: 100,
    maxLineLength: 120,
    ignoreFolderRegularExpression: '.*/res/lua/\\w+\\.lua;.*vscode/LuaPanda/IntelliSenseRes/;',
    ignoreErrorCode: '',
    ignoreGlobal: '',
  },
};
let globalSettings: LuaAnalyzerSettings = defaultSettings;
// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<LuaAnalyzerSettings>> = new Map();

//-----------------------------------------------------------------------------
//-- connection 时序
//-----------------------------------------------------------------------------
// 建立连接，初始化数据和设置能力项
connection.onInitialize((initPara: InitializeParams) => {
  let capabilities = initPara.capabilities;
  Tools.setInitPara(initPara);
  Tools.setToolsConnection(connection);
  Logger.connection = connection;
  // Does the client support the `workspace/configuration` request?
  // If not, we will fall back using global settings
  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
  hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
  // hasDiagnosticRelatedInformationCapability =
  // 	!!(capabilities.textDocument &&
  // 		capabilities.textDocument.publishDiagnostics &&
  // 		capabilities.textDocument.publishDiagnostics.relatedInformation);

  // 清空loadedExt, 初始化 name - uri 对应 cache
  Tools.setVScodeExtensionPath(path.dirname(path.dirname(path.dirname(__dirname))));
  Tools.initLoadedExt();

  // 读取标记文件，如果关闭了标记，那么
  let snippetsPath = Tools.getVScodeExtensionPath() + '/res/snippets/snippets.json';
  let snipContent = fs.readFileSync(snippetsPath);

  // 发送rootFolder
  setImmediate(() => {
    connection.sendNotification('setRootFolders', Tools.getVSCodeOpenedFolders());
  }, 0);

  if (snipContent.toString().trim() == '') {
    analyzerTotalSwitch = false;
    setImmediate(() => {
      connection.sendNotification('showProgress', 'LuaPanda');
    }, 0);
    Logger.InfoLog('LuaAnalyzer closed!');
    return {
      capabilities: {},
    };
  }
  // 创建对应后缀的文件符号
  for (const folder of Tools.getVSCodeOpenedFolders()) {
    CodeSymbol.createSymbolswithExt('lua', folder);
    CodeSymbol.createSymbolswithExt('lua.bytes', folder);
  }
  // 异步执行，建立uri -> 完整路径对应表
  setTimeout(Tools.refresh_FileName_Uri_Cache, 0);
  // 分析默认位置(扩展中)的lua文件
  let resLuaPath = Tools.getVScodeExtensionPath() + '/res/lua'; //安装插件后地址
  CodeSymbol.createLuaPreloadSymbols(resLuaPath); //更新lua预设符号文件
  NativeCodeExportBase.loadIntelliSenseRes(); //更新用户导出符号文件
  Logger.InfoLog('LuaAnalyzer init success!');

  return {
    capabilities: {
      //符号分析
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      //定义分析
      definitionProvider: true,
      //引用分析
      referencesProvider: false,
      //代码格式化
      documentFormattingProvider: true,
      documentRangeFormattingProvider: false,
      //代码选中高亮
      documentHighlightProvider: false,
      //文档同步
      textDocumentSync: documents.syncKind,
      //自动补全
      completionProvider: {
        triggerCharacters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:'.split(''),
        resolveProvider: false,
      },
      //重命名
      renameProvider: false,
      //函数签名提示
      // signatureHelpProvider:{
      // 	triggerCharacters: [ '(' ],
      // },
      //代码上色
      colorProvider: false,
    },
  };
});

connection.onNotification('preAnalysisCpp', (message) => {
  let msgObj = JSON.parse(message);
  let anaPath = msgObj['path'];
  NativeCodeExportBase.processNativeCodeDir(anaPath);
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      // 在工程中增删文件夹的回调
      Logger.DebugLog('Workspace folder change event received.');
      if (_event.added.length > 0) {
        Tools.addOpenedFolder(_event.added);
        for (const folder of Tools.getVSCodeOpenedFolders()) {
          CodeSymbol.refreshFolderSymbols(folder);
        }
      }

      if (_event.removed.length > 0) {
        Tools.removeOpenedFolder(_event.removed);
      }
      // 刷新文件名-路径索引
      setTimeout(Tools.refresh_FileName_Uri_Cache, 0);
    });
  }
});

// 代码格式化
connection.onDocumentFormatting((handler: DocumentFormattingParams): TextEdit[] => {
  let uri = Tools.urlDecode(handler.textDocument.uri);
  let retCode = CodeFormat.format(uri);
  return retCode;
});

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <LuaAnalyzerSettings>(change.settings.lua_analyzer || defaultSettings);
  }
  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

// 代码自动补全
connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
  let uri = Tools.urlDecode(_textDocumentPosition.textDocument.uri);
  let pos = _textDocumentPosition.position;
  try {
    return CodeCompletion.completionEntry(uri, pos);
  } catch (error) {
    Logger.ErrorLog('[Error] onCompletion ' + error.stack);
  }
});

// 查找符号引用
connection.onReferences((handler: ReferenceParams): any => {
  return CodeReference.getSymbalReferences(handler);
});

// 查找符号定义
connection.onDefinition(
  (handler: TextDocumentPositionParams): Definition => {
    handler.textDocument.uri = Tools.urlDecode(handler.textDocument.uri);
    try {
      return CodeDefinition.getSymbalDefine(handler);
    } catch (error) {
      Logger.ErrorLog('[Error] onDefinition ' + error.stack);
    }
  }
);

//获取单文件内的符号
connection.onDocumentSymbol((handler: DocumentSymbolParams): DocumentSymbol[] => {
  let uri = handler.textDocument.uri;
  let decUri = Tools.urlDecode(uri);
  let retSyms = CodeSymbol.getOneDocSymbolsArray(decUri, null, Tools.SearchRange.AllSymbols);
  let retSymsArr: any[];
  try {
    retSymsArr = Tools.getOutlineSymbol(retSyms);
  } catch (error) {
    // 处理层级关系出现错误时退化为原有的不分层显示
    Logger.DebugLog('error detected while processing outline symbols, error: ' + error + '\nstack:\n' + error.stack);
    retSymsArr = Tools.changeDicSymboltoArray(retSyms);
  }
  return retSymsArr;
});

//获取整个工程文件夹的符号
connection.onWorkspaceSymbol((handler: WorkspaceSymbolParams): SymbolInformation[] => {
  try {
    let userInput = handler.query;
    return CodeSymbol.searchSymbolinWorkSpace(userInput);
  } catch (error) {
    Logger.ErrorLog('[Error] onWorkspaceSymbol ' + error.stack);
  }
});

// 打开单文件
documents.onDidOpen((file) => {
  // 异步分析工程中同后缀文件
  if (file.document.languageId == 'lua' && analyzerTotalSwitch) {
    //本文件是lua形式
    try {
      let uri = Tools.urlDecode(file.document.uri);
      let luaExtname = Tools.getPathNameAndExt(uri);
      let ext = luaExtname['ext'];
      let loadedExt = Tools.getLoadedExt();
      if (loadedExt && loadedExt[ext] === true) {
        // VSCode 会自动调用 onDidChangeContent
        return;
      } else {
        // 处理新的后缀类型
        for (const folder of Tools.getVSCodeOpenedFolders()) {
          CodeSymbol.createSymbolswithExt(ext, folder);
        }
        setTimeout(Tools.refresh_FileName_Uri_Cache, 0);
      }
    } catch (error) {
      Logger.ErrorLog('[Error] onDidOpen ' + error.stack);
    }
  }
});

// 文件内容发生改变（首次打开文件时这个方法也会被调用）
documents.onDidChangeContent((change) => {
  if (change.document.languageId == 'lua' && analyzerTotalSwitch) {
    try {
      const uri = Tools.urlDecode(change.document.uri);
      const text = change.document.getText();
      CodeEditor.saveCode(uri, text); //保存代码

      // 过滤掉预分析文件
      if (!Tools.isinPreloadFolder(uri)) {
        CodeSymbol.refreshOneDocSymbols(uri, text);
      } else {
        CodeSymbol.refreshOneUserPreloadDocSymbols(Tools.uriToPath(uri));
      }

      // 运行语法检查
      getDocumentSettings(uri).then((settings) => {
        if (settings.codeLinting.checkWhileTyping == true) {
          validateTextDocument(change.document);
        }
      });
    } catch (error) {
      Logger.ErrorLog('[Error] onDidChangeContent ' + error.stack);
    }
  }
});

// 保存文件
documents.onDidSave((change) => {
  if (!analyzerTotalSwitch) return;

  try {
    // 运行语法检查
    getDocumentSettings(change.document.uri).then((settings) => {
      if (settings.codeLinting.checkAfterSave == true) {
        validateTextDocument(change.document);
      }
    });
  } catch (error) {
    Logger.ErrorLog('[Error] onDidSave ' + error.stack);
  }
});

//-----------------------------------------------------------------------------
//-- 未实现能力
//-----------------------------------------------------------------------------
// 代码着色
connection.onDocumentColor((handler: DocumentColorParams): ColorInformation[] => {
  return new Array<ColorInformation>();
});

connection.onColorPresentation((handler: ColorPresentationParams): ColorPresentation[] => {
  return new Array<ColorPresentation>();
});

//代码单击高亮
connection.onDocumentHighlight((handler: TextDocumentPositionParams): DocumentHighlight[] => {
  return new Array<DocumentHighlight>();
});

//-----------------------------------------------------------------------------
//-- 工具方法
//-----------------------------------------------------------------------------
function getDocumentSettings(resource: string): Thenable<LuaAnalyzerSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'lua_analyzer',
    });
    documentSettings.set(resource, result);
  }
  return result;
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  let settings = await getDocumentSettings(textDocument.uri);

  // 如果总开关未打开，无论从哪里调用validateTextDocument都不执行语法检查直接返回
  if (settings.codeLinting.enable == false) {
    // 清空诊断输出
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
    return;
  }

  // 处理忽略文件
  let ignoreFolderRegExpArray = settings.codeLinting.ignoreFolderRegularExpression.split(';');
  if (ignoreFolderRegExpArray.length > 0) {
    if (Tools.isMatchedIgnoreRegExp(textDocument.uri, ignoreFolderRegExpArray)) {
      // 清空诊断输出
      connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
      return;
    }
  }

  // let globalSymbols = CodeSymbol.getRequireTreeGlobalSymbols(Tools.urlDecode(textDocument.uri));
  let globalSymbols = CodeSymbol.getWorkspaceSymbols(Tools.SearchRange.GlobalSymbols);
  let globalVariables: string[] = Object.keys(globalSymbols);

  let luacheckProcess: Promise<void> = CodeLinting.processLinting(textDocument, settings, globalVariables);
  luacheckProcess
    .then(
      () => {
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
      },
      (luaErrorOrWaining) => {
        const diagnosticArray = CodeLinting.parseLuacheckResult(luaErrorOrWaining, settings);
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: diagnosticArray });
      }
    )
    .catch(() => {
      connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
    });
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// Listen on the connection
connection.listen();
