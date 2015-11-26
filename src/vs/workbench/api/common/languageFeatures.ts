/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import Event, {Emitter} from 'vs/base/common/event';
import Severity from 'vs/base/common/severity';
import {TPromise} from 'vs/base/common/winjs.base';
import {sequence} from 'vs/base/common/async';
import {Range as EditorRange} from 'vs/editor/common/core/range';
import {IDisposable} from 'vs/base/common/lifecycle';
import {IKeybindingService} from 'vs/platform/keybinding/common/keybindingService';
import {Remotable, IThreadService} from 'vs/platform/thread/common/thread';
import * as vscode from 'vscode';
import * as TypeConverters from 'vs/workbench/api/common/pluginHostTypeConverters';
import {Position, Range, SymbolKind, DocumentHighlightKind, Disposable, Diagnostic, DiagnosticSeverity, Location, SignatureHelp, CompletionItemKind} from 'vs/workbench/api/common/pluginHostTypes';
import {IPosition, IRange, ISingleEditOperation} from 'vs/editor/common/editorCommon';
import * as modes from 'vs/editor/common/modes';
import {CancellationTokenSource} from 'vs/base/common/cancellation';
import {PluginHostModelService} from 'vs/workbench/api/common/pluginHostDocuments';
import {IMarkerService, IMarker} from 'vs/platform/markers/common/markers';
import {PluginHostCommands, MainThreadCommands} from 'vs/workbench/api/common/pluginHostCommands';
import LanguageFeatureRegistry from 'vs/editor/common/modes/languageFeatureRegistry';
import {NavigateTypesSupportRegistry, INavigateTypesSupport, ITypeBearing} from 'vs/workbench/parts/search/common/search'
import {RenameRegistry} from 'vs/editor/contrib/rename/common/rename';
import {FormatRegistry, FormatOnTypeRegistry} from 'vs/editor/contrib/format/common/format';
import {ParameterHintsRegistry} from 'vs/editor/contrib/parameterHints/common/parameterHints';
import {SuggestRegistry} from 'vs/editor/contrib/suggest/common/suggest';

function isThenable<T>(obj: any): obj is Thenable<T> {
	return obj && typeof obj['then'] === 'function';
}

function asWinJsPromise<T>(callback: (token: vscode.CancellationToken) => T | Thenable<T>): TPromise<T> {
	let source = new CancellationTokenSource();
	return new TPromise<T>((resolve, reject) => {
		let item = callback(source.token);
		if (isThenable<T>(item)) {
			item.then(resolve, reject);
		} else {
			resolve(item);
		}
	}, () => {
		source.cancel();
	});
}

export abstract class AbstractMainThreadFeature<T> {

	private _id: string;
	protected _commands: PluginHostCommands;
	protected _refCount = 0;
	protected _disposable: IDisposable;
	protected _registry: LanguageFeatureRegistry<T>;

	constructor(id: string, registry: LanguageFeatureRegistry<T>, @IThreadService threadService: IThreadService) {
		this._id = id;
		this._registry = registry;
		this._commands = threadService.getRemotable(PluginHostCommands);
	}

	_getId(): TPromise<string> {
		return TPromise.as(this._id);
	}

	_register(selector: vscode.DocumentSelector): TPromise<any> {
		if (this._refCount++ === 0) {
			this._disposable = this._registry.register(selector, <any> this);
		}
		return undefined;
	}

	_unregister(): TPromise<any> {
		if (--this._refCount === 0) {
			this._disposable.dispose();
		}
		return undefined;
	}

	_executeCommand<T>(...args:any[]):TPromise<T> {
		let result = this._commands.executeCommand<any>(this._id, ...args);
		return new TPromise<T>((c, e) => {
			result.then(c, e);
		});
	}
}

export abstract class AbstractExtensionHostFeature<T, P extends AbstractMainThreadFeature<any>> {

	protected _commands: PluginHostCommands;
	protected _proxy: P;
	protected _registry = new LanguageFeatureRegistry<T>();
	protected _models: PluginHostModelService;

	constructor(proxy: P, @IThreadService threadService: IThreadService) {
		this._proxy = proxy;
		this._models = threadService.getRemotable(PluginHostModelService);
		this._commands = threadService.getRemotable(PluginHostCommands);

		proxy._getId().then(value => this._commands.registerCommand(value, this._runAsCommand, this));
	}

	register(selector: vscode.DocumentSelector, provider: T): vscode.Disposable {

		let disposable = this._registry.register(selector, provider);
		let registered = this._proxy._register(selector);

		return new Disposable(() => {
			disposable.dispose(); // remove locally
			registered.then(() => this._proxy._unregister());
		});
	}

	protected abstract _runAsCommand(...args: any[]): any;

	protected _getAllFor(document: vscode.TextDocument): T[] {
		return this._registry.all({
			language: document.languageId,
			uri: <any> document.uri
		});
	}

	protected _getOrderedFor(document: vscode.TextDocument): T[] {
		return this._registry.ordered({
			language: document.languageId,
			uri: <any>document.uri
		});
	}
}


// --- format

export class ExtHostFormatDocument extends AbstractExtensionHostFeature<vscode.DocumentFormattingEditProvider, MainThreadFormatDocument> {

	constructor( @IThreadService threadService: IThreadService) {
		super(threadService.getRemotable(MainThreadFormatDocument), threadService);
	}

	_runAsCommand(resource: URI, options: modes.IFormattingOptions): TPromise<ISingleEditOperation[]> {

		let document = this._models.getDocument(resource);
		let provider = this._getOrderedFor(document)[0];

		return asWinJsPromise(token => provider.provideDocumentFormattingEdits(document, <any>options, token)).then(result => {
			if (Array.isArray(result)) {
				return result.map(ExtHostFormatDocument.convertTextEdit);
			}
		});
	}

	static convertTextEdit(edit: vscode.TextEdit): ISingleEditOperation {
		return <ISingleEditOperation>{
			text: edit.newText,
			range: TypeConverters.fromRange(edit.range)
		}
	}
}

@Remotable.MainContext('MainThreadFormatDocument')
export class MainThreadFormatDocument extends AbstractMainThreadFeature<modes.IFormattingSupport> implements modes.IFormattingSupport {

	constructor( @IThreadService threadService: IThreadService) {
		super('vscode.executeFormatDocumentProvider', FormatRegistry, threadService);
	}

	formatDocument(resource: URI, options: modes.IFormattingOptions):TPromise<ISingleEditOperation[]> {
		return this._executeCommand(resource, options);
	}
}

export class ExtHostFormatRange extends AbstractExtensionHostFeature<vscode.DocumentRangeFormattingEditProvider, MainThreadFormatRange> {

	constructor( @IThreadService threadService: IThreadService) {
		super(threadService.getRemotable(MainThreadFormatRange), threadService);
	}

	_runAsCommand(resource: URI, range: IRange, options: modes.IFormattingOptions): TPromise<ISingleEditOperation[]> {

		let document = this._models.getDocument(resource);
		let provider = this._getOrderedFor(document)[0];
		let ran: Range;

		if (range) {
			ran = TypeConverters.toRange(range);
		} else {
			let lastLine = document.lineAt(document.lineCount - 1);
			let {line, character} = lastLine.range.end;
			ran = new Range(0, 0, line, character);
		}

		return asWinJsPromise(token => provider.provideDocumentRangeFormattingEdits(document, ran, <any>options, token)).then(result => {
			if (Array.isArray(result)) {
				return result.map(ExtHostFormatDocument.convertTextEdit);
			}
		});
	}
}

@Remotable.MainContext('MainThreadFormatRange')
export class MainThreadFormatRange extends AbstractMainThreadFeature<modes.IFormattingSupport> implements modes.IFormattingSupport {

	constructor( @IThreadService threadService: IThreadService) {
		super('vscode.executeFormatRangeProvider', FormatRegistry, threadService);
	}

	formatRange(resource: URI, range:IRange, options: modes.IFormattingOptions):TPromise<ISingleEditOperation[]> {
		return this._executeCommand(resource, range, options);
	}
}

// --- format on type

export interface FormatOnTypeEntry {
	triggerCharacters: string[];
	provider: vscode.OnTypeFormattingEditProvider;
}

export class ExtHostFormatOnType extends AbstractExtensionHostFeature<FormatOnTypeEntry, MainThreadFormatOnType> {

	constructor( @IThreadService threadService: IThreadService) {
		super(threadService.getRemotable(MainThreadFormatOnType), threadService);
	}

	register(selector: vscode.DocumentSelector, provider: FormatOnTypeEntry): vscode.Disposable {

		let disposable = this._registry.register(selector, provider);
		let registered = this._proxy._register(selector, provider.triggerCharacters);

		return new Disposable(() => {
			disposable.dispose();
			registered.then(() => this._proxy._unregister());
		});
	}

	_runAsCommand(resource: URI, position: IPosition, ch: string, options: modes.IFormattingOptions): TPromise<ISingleEditOperation[]> {

		let document = this._models.getDocument(resource);
		let pos = TypeConverters.toPosition(position);

		let ordered = this._getOrderedFor(document);
		let provider: vscode.OnTypeFormattingEditProvider;
		for (let entry of ordered) {
			if (entry.triggerCharacters.indexOf(ch) >= 0) {
				provider = entry.provider;
				break;
			}
		}

		if (provider) {
			return asWinJsPromise(token => provider.provideOnTypeFormattingEdits(document, pos, ch, <any>options, token)).then(result => {
				if (Array.isArray(result)) {
					return result.map(ExtHostFormatDocument.convertTextEdit);
				}
			});
		}
	}
}

@Remotable.MainContext('MainThreadFormatOnType')
export class MainThreadFormatOnType extends AbstractMainThreadFeature<modes.IFormattingSupport> implements modes.IFormattingSupport {

	autoFormatTriggerCharacters: string[] = [];

	constructor( @IThreadService threadService: IThreadService) {
		super('vscode.executeFormatOnTypeProvider', FormatOnTypeRegistry, threadService);
	}

	_register(selector: vscode.DocumentSelector, triggerCharacters: string[] = []): TPromise<number> {
		this.autoFormatTriggerCharacters.push(...triggerCharacters);
		return super._register(selector);
	}

	formatDocument(resource: URI, options: modes.IFormattingOptions):TPromise<ISingleEditOperation[]> {
		throw new Error('format on type only');
	}

	formatAfterKeystroke(resource: URI, position: IPosition, ch: string, options: modes.IFormattingOptions): TPromise<ISingleEditOperation[]> {
		return this._executeCommand(resource, position, ch, options);
	}
}

// ---- signature help

export interface SignatureHelpEntry {
	provider: vscode.SignatureHelpProvider;
	triggerCharacters: string[];
}

export class ExtHostSignatureHelp extends AbstractExtensionHostFeature<SignatureHelpEntry, MainThreadSignatureHelp> {

	constructor( @IThreadService threadService: IThreadService) {
		super(threadService.getRemotable(MainThreadSignatureHelp), threadService);
	}

	register(selector: vscode.DocumentSelector, entry: SignatureHelpEntry): vscode.Disposable {

		let disposable = this._registry.register(selector, entry);
		let registered = this._proxy._register(selector, entry.triggerCharacters);

		return new Disposable(() => {
			disposable.dispose();
			registered.then(() => this._proxy._unregister());
		});
	}

	_runAsCommand(resource: URI, position: IPosition, triggerCharacter?: string): TPromise<modes.IParameterHints> {

		let document = this._models.getDocument(resource);
		let pos = TypeConverters.toPosition(position);

		let entry = this._getOrderedFor(document)[0];
		if (entry) {

			if (triggerCharacter) {
				if (entry.triggerCharacters.indexOf(triggerCharacter) < 0) {
					return;
				}
			}

			return asWinJsPromise(token => entry.provider.provideSignatureHelp(document, pos, token)).then(result => {
				if (result instanceof SignatureHelp) {
					return ExtHostSignatureHelp._convertSignatureHelp(result);
				}
			});
		}
	}

	private static _convertSignatureHelp(signatureHelp: SignatureHelp): modes.IParameterHints {

		let result: modes.IParameterHints = {
			currentSignature: signatureHelp.activeSignature,
			currentParameter: signatureHelp.activeParameter,
			signatures: []
		}

		for (let signature of signatureHelp.signatures) {

			let signatureItem: modes.ISignature = {
				label: signature.label,
				documentation: signature.documentation,
				parameters: []
			};

			let idx = 0;
			for (let parameter of signature.parameters) {

				let parameterItem: modes.IParameter = {
					label: parameter.label,
					documentation: parameter.documentation,
				};

				signatureItem.parameters.push(parameterItem);
				idx = signature.label.indexOf(parameter.label, idx);

				if (idx >= 0) {
					parameterItem.signatureLabelOffset = idx;
					idx += parameter.label.length;
					parameterItem.signatureLabelEnd = idx;
				}
			}

			result.signatures.push(signatureItem);
		}

		return result;
	}
}

@Remotable.MainContext('MainThreadSignatureHelp')
export class MainThreadSignatureHelp extends AbstractMainThreadFeature<modes.IParameterHintsSupport> implements modes.IParameterHintsSupport {

	private _triggerCharacters: string[] = [];

	constructor( @IThreadService threadService: IThreadService) {
		super('vscode.executeSignatureHelpProvider', ParameterHintsRegistry, threadService);
	}

	_register(selector: vscode.DocumentSelector, triggerCharacters: string[] = []): TPromise<number> {
		this._triggerCharacters.push(...triggerCharacters);
		return super._register(selector);
	}

	getParameterHintsTriggerCharacters(): string[] {
		return this._triggerCharacters;
	}

	shouldTriggerParameterHints(context: modes.ILineContext, offset: number): boolean {
		return true;
	}

	getParameterHints(resource: URI, position: IPosition, triggerCharacter?: string): TPromise<modes.IParameterHints> {
		return this._executeCommand(resource, position, triggerCharacter);
	}
}

// ---- Completions


export namespace LanguageFeatures {

	export function createMainThreadInstances(threadService: IThreadService): void {
		threadService.getRemotable(MainThreadSignatureHelp);
	}

	export function createExtensionHostInstances(threadService: IThreadService) {
		return {
			signatureHelp: new ExtHostSignatureHelp(threadService),
		};
	}
}