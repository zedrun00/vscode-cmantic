import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as util from './utility';


const re_primitiveType = /\b(void|bool|char|wchar_t|char8_t|char16_t|char32_t|int|short|long|signed|unsigned|float|double)\b/g;

// Extends DocumentSymbol by adding a parent property and making sure that children are sorted by range.
export class SourceSymbol extends vscode.DocumentSymbol
{
    readonly uri: vscode.Uri;
    parent?: SourceSymbol;
    children: SourceSymbol[];

    get location(): vscode.Location { return new vscode.Location(this.uri, this.range); }

    constructor(docSymbol: vscode.DocumentSymbol, uri: vscode.Uri, parent?: SourceSymbol)
    {
        super(docSymbol.name, docSymbol.detail, docSymbol.kind, docSymbol.range, docSymbol.selectionRange);
        this.uri = uri;
        this.parent = parent;

        // Sorts docSymbol.children based on their relative position to eachother.
        docSymbol.children.sort((a: vscode.DocumentSymbol, b: vscode.DocumentSymbol) => {
            return a.range.start.isAfter(b.range.start) ? 1 : -1;
        });

        // Convert docSymbol.children to SourceSymbols to set the children property.
        let convertedChildren: SourceSymbol[] = [];
        docSymbol.children.forEach(child => {
            convertedChildren.push(new SourceSymbol(child, uri, this));
        });

        this.children = convertedChildren;
    }

    findChild(compareFn: (child: SourceSymbol) => boolean): SourceSymbol | undefined
    {
        for (const child of this.children) {
            if (compareFn(child)) {
                return child;
            }
        }
    }

    isMemberVariable(): boolean
    {
        return this.kind === vscode.SymbolKind.Field;
    }

    isFunction(): boolean
    {
        switch (this.kind) {
        case vscode.SymbolKind.Operator:
        case vscode.SymbolKind.Method:
        case vscode.SymbolKind.Constructor:
        case vscode.SymbolKind.Function:
            return true;
        default:
            return false;
        }
    }

}

// A DocumentSymbol/SourceSymbol that understands the semantics of C/C++.
export class CSymbol extends SourceSymbol
{
    readonly document: vscode.TextDocument;
    parent?: CSymbol;
    children: CSymbol[];

    // When constructing with a SourceSymbol that has a parent, the parent parameter may be omitted.
    constructor(symbol: vscode.DocumentSymbol | SourceSymbol, document: vscode.TextDocument, parent?: CSymbol)
    {
        super(symbol, document.uri, parent);
        this.document = document;

        if (symbol instanceof SourceSymbol && symbol.parent && !parent) {
            this.parent = new CSymbol(symbol.parent, document);
        } else {
            this.parent = parent;
        }

        symbol = (symbol instanceof SourceSymbol) ? symbol : new SourceSymbol(symbol, document.uri, parent);

        // Convert symbol.children to CSymbols to set the children property.
        let convertedChildren: CSymbol[] = [];
        symbol.children.forEach(child => {
            convertedChildren.push(new CSymbol(child, document, this));
        });

        this.children = convertedChildren;
    }

    findChild(compareFn: (child: CSymbol) => boolean): CSymbol | undefined
    {
        for (const child of this.children) {
            if (compareFn(child)) {
                return child;
            }
        }
    }

    // Returns all the text contained in this symbol.
    text(): string { return this.document.getText(this.range); }

    // Returns the identifier of this symbol, such as a function name. this.id() != this.name for functions.
    id(): string { return this.document.getText(this.selectionRange); }

    // Checks for common naming schemes of private members and return the base name.
    baseName(): string
    {
        const memberName = this.id();
        let baseMemberName: string | undefined;
        let match = /^_+[\w_][\w\d_]*_*$/.exec(memberName);
        if (match && !baseMemberName) {
            baseMemberName = memberName.replace(/^_+|_*$/g, '');
        }
        match = /^_*[\w_][\w\d_]*_+$/.exec(memberName);
        if (match && !baseMemberName) {
            baseMemberName = memberName.replace(/^_*|_+$/g, '');
        }
        match = /^m_[\w_][\w\d_]*$/.exec(memberName);
        if (match && !baseMemberName) {
            baseMemberName = memberName.replace(/^m_/, '');
        }

        return baseMemberName ? baseMemberName : memberName;
    }

    getterName(memberBaseName?: string): string
    {
        if (!this.isMemberVariable()) {
            return '';
        }

        memberBaseName = memberBaseName ? memberBaseName : this.baseName();
        if (memberBaseName === this.id()) {
            return 'get' + util.firstCharToUpper(memberBaseName);
        }
        return memberBaseName;
    }

    setterName(memberBaseName?: string): string
    {
        if (!this.isMemberVariable()) {
            return '';
        }

        memberBaseName = memberBaseName ? memberBaseName : this.baseName();
        return 'set' + util.firstCharToUpper(memberBaseName);
    }

    findGetterFor(memberVariable: CSymbol): CSymbol | undefined
    {
        if (memberVariable.parent !== this || !memberVariable.isMemberVariable()) {
            return;
        }

        const getterName = memberVariable.getterName();

        return this.findChild(child => child.id() === getterName);
    }

    findSetterFor(memberVariable: CSymbol): CSymbol | undefined
    {
        if (memberVariable.parent !== this || !memberVariable.isMemberVariable()) {
            return;
        }

        const setterName = memberVariable.setterName();

        return this.findChild(child => child.id() === setterName);
    }

    isBefore(offset: number): boolean { return this.document.offsetAt(this.range.end) < offset; }

    isAfter(offset: number): boolean { return this.document.offsetAt(this.range.start) > offset; }

    // Returns the text contained in this symbol that comes before this.id().
    leading(): string
    {
        return this.document.getText(new vscode.Range(this.range.start, this.selectionRange.start));
    }

    // Returns an array of CSymbol's starting with the top-most ancestor and ending with this.parent.
    // Returns an empty array if this is a top-level symbol (parent is undefined).
    scopes(): CSymbol[]
    {
        let scopes: CSymbol[] = [];
        let symbol: CSymbol = this;
        while (symbol.parent) {
            scopes.push(symbol.parent);
            symbol = symbol.parent;
        }
        return scopes.reverse();
    }

    // Finds the most likely definition of this CSymbol in the case that multiple are found.
    async findDefinition(): Promise<vscode.Location | undefined>
    {
        return await findDefinitionInWorkspace(this.selectionRange.start, this.uri);
    }

    // Finds a position for a new public method within this class or struct.
    // Optionally provide a relativeName to look for a position next to.
    // Optionally provide a memberVariable if the new method is an accessor.
    // Returns undefined if this is not a class or struct, or when this.children.length === 0.
    findPositionForNewMethod(relativeName?: string, memberVariable?: CSymbol): ProposedPosition | undefined
    {
        const lastChildPositionOrUndefined = (): ProposedPosition | undefined => {
            if (this.children.length === 0) {
                return undefined;
            }
            return { value: this.children[this.children.length - 1].range.end, after: true };
        };

        const symbolIsBetween = (symbol: CSymbol, afterOffset: number, beforeOffset: number): boolean => {
            if (symbol.isFunction() && symbol.isAfter(afterOffset) && symbol.isBefore(beforeOffset)) {
                return true;
            }
            return false;
        };

        if (this.kind !== vscode.SymbolKind.Class && this.kind !== vscode.SymbolKind.Struct) {
            return lastChildPositionOrUndefined();
        }

        const text = this.text();
        const startOffset = this.document.offsetAt(this.range.start);
        let publicSpecifierOffset = /\bpublic\s*:/g.exec(text)?.index;

        if (!publicSpecifierOffset) {
            return lastChildPositionOrUndefined();
        }
        publicSpecifierOffset += startOffset;

        let nextAccessSpecifierOffset: number | undefined;
        for (const match of text.matchAll(/\w[\w\d]*\s*:(?!:)/g)) {
            if (!match.index) {
                continue;
            }
            if (match.index > publicSpecifierOffset) {
                nextAccessSpecifierOffset = match.index;
                break;
            }
        }

        if (!nextAccessSpecifierOffset) {
            nextAccessSpecifierOffset = this.document.offsetAt(this.range.end);
        } else {
            nextAccessSpecifierOffset += startOffset;
        }

        let fallbackPosition: ProposedPosition | undefined;
        let fallbackIndex = 0;
        for (let i = this.children.length - 1; i >= 0; --i) {
            const symbol = new CSymbol(this.children[i], this.document, this);
            if (symbolIsBetween(symbol, publicSpecifierOffset, nextAccessSpecifierOffset)) {
                fallbackPosition = { value: symbol.range.end, after: true };
                fallbackIndex = i;
                break;
            }
        }

        if (!fallbackPosition || !fallbackIndex) {
            return lastChildPositionOrUndefined();
        } else if (!relativeName) {
            return fallbackPosition;
        }

        // If relativeName is a setterName, then ProposedPosition should be before, since the new method is a getter.
        // This is to match the positioning of these methods when both are generated at the same time.
        const isGetter = memberVariable ? relativeName === memberVariable.setterName() : false;

        for (let i = fallbackIndex; i >= 0; --i) {
            const symbol = new CSymbol(this.children[i], this.document, this);
            if (symbolIsBetween(symbol, publicSpecifierOffset, nextAccessSpecifierOffset) && symbol.id() === relativeName) {
                if (isGetter) {
                    return { value: symbol.range.start, before: true, nextTo: true };
                } else {
                    return { value: symbol.range.end, after: true, nextTo: true };
                }
            }
        }

        return fallbackPosition;
    }

    isMemberVariable(): boolean
    {
        return this.kind === vscode.SymbolKind.Field;
    }

    isFunction(): boolean
    {
        switch (this.kind) {
        case vscode.SymbolKind.Operator:
        case vscode.SymbolKind.Method:
        case vscode.SymbolKind.Constructor:
        case vscode.SymbolKind.Function:
            return true;
        default:
            return false;
        }
    }

    isFunctionDeclaration(): boolean
    {
        return this.isFunction() && (this.detail === 'declaration' || !this.text().endsWith('}'));
    }

    isConstructor(): boolean
    {
        switch (this.kind) {
        case vscode.SymbolKind.Constructor:
            return true;
        case vscode.SymbolKind.Method:
            return this.id() === this.parent?.id();
        default:
            return false;
        }
    }

    isDestructor(): boolean
    {
        switch (this.kind) {
        case vscode.SymbolKind.Constructor:
        case vscode.SymbolKind.Method:
            return this.id() === '~' + this.parent?.id();
        default:
            return false;
        }
    }

    isConstexpr(): boolean
    {
        if (this.leading().match(/\bconstexpr\b/)) {
            return true;
        }
        return false;
    }

    isInline(): boolean
    {
        if (this.leading().match(/\binline\b/)) {
            return true;
        }
        return false;
    }

    isPointer(): boolean
    {
        return this.leading().includes('*') ? true : false;
    }

    isConst(): boolean
    {
        if (this.leading().match(/\bconst\b/)) {
            return true;
        }
        return false;
    }

    isPrimitive(): boolean
    {
        // TODO: Resolve typedefs and using-declarations.
        const leading = this.leading();
        if (leading.match(re_primitiveType) && !leading.match(/[<>]/g)) {
            return true;
        }
        return false;
    }

    // Formats this function declaration for use as a definition (without curly braces).
    async newFunctionDefinition(target: SourceFile, position?: vscode.Position): Promise<string>
    {
        if (!this.isFunctionDeclaration()) {
            return '';
        }

        // Build scope string to prepend to function name.
        // Check if position exists inside of namespace block. If so, omit that scope.id().
        let scopeString = '';
        for (const scope of this.scopes()) {
            const targetScope = await target.findMatchingSymbol(scope);
            if (!targetScope || (position && !targetScope.range.contains(position))) {
                scopeString += scope.id() + '::';
            }
        }

        const funcName = this.id();
        const declaration = this.text();
        const maskedDeclaration = maskUnimportantText(declaration);

        const paramStart = maskedDeclaration.indexOf('(', maskedDeclaration.indexOf(funcName) + funcName.length) + 1;
        const lastParen = maskedDeclaration.lastIndexOf(')');
        const trailingReturnOperator = maskedDeclaration.substring(paramStart, lastParen).indexOf('->');
        const paramEnd = (trailingReturnOperator === -1) ?
                lastParen : maskedDeclaration.substring(paramStart, trailingReturnOperator).lastIndexOf(')');
        const parameters = stripDefaultValues(declaration.substring(paramStart, paramEnd));

        // Intelligently align the definition in the case of a multi-line declaration.
        let leadingText = this.leading();
        const l = this.document.lineAt(this.range.start);
        const leadingIndent = l.text.substring(0, l.firstNonWhitespaceCharacterIndex).length;
        const re_newLineAlignment = new RegExp('^' + ' '.repeat(leadingIndent + leadingText.length), 'gm');
        leadingText = leadingText.replace(/\b(virtual|static|explicit|friend)\b\s*/g, '');
        let definition = funcName + '(' + parameters + ')'
                + declaration.substring(paramEnd + 1, declaration.length - 1);
        definition = definition.replace(re_newLineAlignment, ' '.repeat(leadingText.length + scopeString.length));

        definition = leadingText + scopeString + definition;
        definition = definition.replace(/\s*\b(override|final)\b/g, '');

        return definition;
    }
}


// Represents a C/C++ source file.
export class SourceFile
{
    readonly uri: vscode.Uri;
    symbols?: SourceSymbol[];

    constructor(uri: vscode.Uri)
    {
        this.uri = uri;
    }

    /* Executes the 'vscode.executeDocumentSymbolProvider' command and converts them to
     * SourceSymbols to update the symbols property. Returns a reference to the new symbols.
     * Methods that use the symbols property will call this automatically if needed. */
    async executeSourceSymbolProvider(): Promise<SourceSymbol[]>
    {
        const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', this.uri);
        if (!documentSymbols) {
            return [];
        }

        documentSymbols.sort((a: vscode.DocumentSymbol, b: vscode.DocumentSymbol) => {
            return a.range.start.isAfter(b.range.start) ? 1 : -1;
        });

        this.symbols = [];
        documentSymbols.forEach(newSymbol => {
            this.symbols?.push(new SourceSymbol(newSymbol, this.uri));
        });

        return this.symbols;
    }

    async getSymbol(position: vscode.Position): Promise<SourceSymbol | undefined>
    {
        if (!this.symbols) {
            this.symbols = await this.executeSourceSymbolProvider();
        }

        const searchSymbolTree = (sourceSymbols: SourceSymbol[]): SourceSymbol | undefined => {
            for (const sourceSymbol of sourceSymbols) {
                if (!sourceSymbol.range.contains(position)) {
                    continue;
                }

                if (sourceSymbol.children.length === 0) {
                    return sourceSymbol;
                } else {
                    return searchSymbolTree(sourceSymbol.children);
                }
            }
        };

        return searchSymbolTree(this.symbols);
    }

    async findMatchingSymbol(target: vscode.DocumentSymbol): Promise<vscode.DocumentSymbol | undefined>
    {
        if (!this.symbols) {
            this.symbols = await this.executeSourceSymbolProvider();
        }

        const searchSymbolTree = (symbolResults: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
            const docSymbols = symbolResults as vscode.DocumentSymbol[];
            for (const docSymbol of docSymbols) {
                if (docSymbol.name === target.name) {
                    return docSymbol;
                } else {
                    return searchSymbolTree(docSymbol.children);
                }
            }
        };

        return searchSymbolTree(this.symbols);
    }

    async findDefinition(position: vscode.Position): Promise<vscode.Location | undefined>
    {
        return await findDefinitionInWorkspace(position, this.uri);
    }

    isHeader(): boolean
    {
        return SourceFile.isHeader(this.uri.path);
    }

    static isHeader(fileName: string): boolean
    {
        return cfg.headerExtensions().includes(util.fileExtension(fileName));
    }

    async findMatchingSourceFile(): Promise<vscode.Uri | undefined>
    {
        return SourceFile.findMatchingSourceFile(this.uri.path);
    }

    static async findMatchingSourceFile(fileName: string): Promise<vscode.Uri | undefined>
    {
        const extension = util.fileExtension(fileName);
        const baseName = util.fileNameBase(fileName);
        const directory = util.directory(fileName);
        const headerExtensions = cfg.headerExtensions();
        const sourceExtensions = cfg.sourceExtensions();

        let globPattern: string;
        if (headerExtensions.indexOf(extension) !== -1) {
            globPattern = `**/${baseName}.{${sourceExtensions.join(",")}}`;
        } else if (sourceExtensions.indexOf(extension) !== -1) {
            globPattern = `**/${baseName}.{${headerExtensions.join(",")}}`;
        } else {
            return;
        }

        const uris = await vscode.workspace.findFiles(globPattern);
        let bestMatch: vscode.Uri | undefined;
        let smallestDiff: number | undefined;

        for (const uri of uris) {
            if (uri.scheme !== 'file') {
                continue;
            }

            const diff = util.compareDirectoryPaths(util.directory(uri.path), directory);
            if (typeof smallestDiff === 'undefined' || diff < smallestDiff) {
                smallestDiff = diff;
                bestMatch = uri;
            }
        }

        return bestMatch;
    }
}


export class SourceDocument extends SourceFile
{
    readonly document: vscode.TextDocument;

    constructor(document: vscode.TextDocument)
    {
        super(document.uri);
        this.document = document;
    }

    text(): string { return this.document.getText(); }

    async getSymbol(position: vscode.Position): Promise<CSymbol | undefined>
    {
        const sourceSymbol = await super.getSymbol(position);
        if (!sourceSymbol) {
            return;
        }

        return new CSymbol(sourceSymbol, this.document);
    }

    async findMatchingSymbol(target: vscode.DocumentSymbol): Promise<CSymbol | undefined>
    {
        const sourceSymbol = await super.findMatchingSymbol(target);
        if (!sourceSymbol) {
            return;
        }

        return new CSymbol(sourceSymbol, this.document);
    }

    async hasHeaderGuard(): Promise<boolean>
    {
        if (this.text().match(/^\s*#pragma\s+once\b/)) {
            return true;
        }

        if (!this.symbols) {
            this.symbols = await this.executeSourceSymbolProvider();
        }

        const headerGuardDefine = cfg.headerGuardDefine(util.fileName(this.uri.path));
        for (const symbol of this.symbols) {
            if (symbol.name === headerGuardDefine) {
                return true;
            }
        }

        return false;
    }

    // Returns the best position to place the definition for declaration.
    // If target is undefined the position will be for this SourceFile.
    async findPositionForNewDefinition(declaration: SourceSymbol, target?: SourceDocument): Promise<ProposedPosition>
    {
        if (!this.symbols) {
            this.symbols = await this.executeSourceSymbolProvider();
        }
        if (declaration.uri.path !== this.uri.path || (!declaration.parent && this.symbols.length === 0)) {
            return { value: new vscode.Position(0, 0) };
        }

        if (!target) {
            target = this;
        }
        if (!target.symbols) {
            target.symbols = await target.executeSourceSymbolProvider();
            if (target.symbols.length === 0) {
                for (let i = target.document.lineCount - 1; i >= 0; --i) {
                    if (!target.document.lineAt(i).isEmptyOrWhitespace) {
                        return { value: target.document.lineAt(i).range.end, after: true };
                    }
                }
                return { value: new vscode.Position(0, 0) };
            }
        }

        // Split sibling symbols into those that come before and after the declaration in this source file.
        const siblingSymbols = declaration.parent ? declaration.parent.children : this.symbols;
        let before: vscode.DocumentSymbol[] = [];
        let after: vscode.DocumentSymbol[] = [];
        let hitTarget = false;
        for (const symbol of siblingSymbols) {
            if (symbol.range === declaration.range) {
                hitTarget = true;
                continue;
            }

            if (!hitTarget) {
                before.push(symbol);
            } else {
                after.push(symbol);
            }
        }

        // Find the closest relative definition to place the new definition next to.
        for (const symbol of before.reverse()) {
            const definitionLocation = await findDefinitionInWorkspace(symbol.selectionRange.start, this.uri);
            if (!definitionLocation || definitionLocation.uri.path !== target.uri.path) {
                continue;
            }

            const definition = await target.getSymbol(definitionLocation.range.start);
            if (definition) {
                return { value: getEndOfStatement(definition.range.end, target.document), after: true };
            }
        }
        for (const symbol of after) {
            const definitionLocation = await findDefinitionInWorkspace(symbol.selectionRange.start, this.uri);
            if (!definitionLocation || definitionLocation.uri.path !== target.uri.path) {
                continue;
            }

            const definition = await target.getSymbol(definitionLocation.range.start);
            if (definition) {
                return { value: getEndOfStatement(definition.range.start, target.document), before: true };
            }
        }

        // If a relative definition could not be found then return the range of the last symbol in the target file.
        return {
            value: getEndOfStatement(target.symbols[target.symbols.length - 1].range.end, target.document),
            after: true
        };
    }

    // Returns the best positions to place new includes (system and project includes).
    async findPositionForNewInclude(): Promise<{ system: vscode.Position; project: vscode.Position }>
    {
        // TODO: Clean up this mess.
        const largestBlock = (
            line: vscode.TextLine, start: vscode.Position, largest: vscode.Range | undefined
        ): vscode.Range => {
            const r = new vscode.Range(start, line.range.start);
            return (!largest || r > largest) ? r : largest;
        };

        let systemIncludeStart: vscode.Position | undefined;
        let projectIncludeStart: vscode.Position | undefined;
        let largestSystemIncludeBlock: vscode.Range | undefined;
        let largestProjectIncludeBlock: vscode.Range | undefined;
        for (let i = 0; i < this.document.lineCount; ++i) {
            const line = this.document.lineAt(i);
            if (!line.text.trim().match(/^#include\s*(<.+>)|(".+")$/)) {
                if (systemIncludeStart) {
                    largestSystemIncludeBlock = largestBlock(line, systemIncludeStart, largestSystemIncludeBlock);
                    systemIncludeStart = undefined;
                } else if (projectIncludeStart) {
                    largestProjectIncludeBlock = largestBlock(line, projectIncludeStart, largestProjectIncludeBlock);
                    projectIncludeStart = undefined;
                }
            } else if (line.text.match(/<.+>/)) {
                if (!systemIncludeStart) {
                    systemIncludeStart = line.range.start;
                }
                if (projectIncludeStart) {
                    largestProjectIncludeBlock = largestBlock(line, projectIncludeStart, largestProjectIncludeBlock);
                    projectIncludeStart = undefined;
                }
            } else if (line.text.match(/".+"/)) {
                if (!projectIncludeStart) {
                    projectIncludeStart = line.range.start;
                }
                if (systemIncludeStart) {
                    largestSystemIncludeBlock = largestBlock(line, systemIncludeStart, largestSystemIncludeBlock);
                    systemIncludeStart = undefined;
                }
            }
        }

        let systemIncludePos: vscode.Position | undefined;
        let projectIncludePos: vscode.Position | undefined;
        if (largestSystemIncludeBlock) {
            systemIncludePos = largestSystemIncludeBlock.end;
            if (!largestProjectIncludeBlock) {
                projectIncludePos = systemIncludePos;
            }
        }
        if (largestProjectIncludeBlock) {
            projectIncludePos = largestProjectIncludeBlock.end;
            if (!largestSystemIncludeBlock) {
                systemIncludePos = projectIncludePos;
            }
        }
        if (systemIncludePos && projectIncludePos) {
            return { system: systemIncludePos, project: projectIncludePos };
        }

        let startLineNum = this.document.lineCount - 1;
        if (!this.symbols) {
            this.symbols = await this.executeSourceSymbolProvider();
        }
        if (this.symbols.length === 0) {
            startLineNum = this.document.lineCount - 1;
        } else {
            startLineNum = this.symbols[0].range.start.line;
        }

        for (let i = startLineNum; i >= 0; --i) {
            const line = this.document.lineAt(i);
            if (!line.isEmptyOrWhitespace) {
                return { system: line.range.end, project: line.range.end };
            }
        }

        return { system: new vscode.Position(0, 0), project: new vscode.Position(0, 0) };
    }

    // Finds a position for a header guard by skipping over any comments that appear at the top of the file.
    findPositionForNewHeaderGuard(): ProposedPosition
    {
        const maskedText = this.text().replace(/\/\*(\*(?=\/)|[^*])*\*\//g, match => ' '.repeat(match.length))
                                      .replace(/\/\/.*/g, match => ' '.repeat(match.length));
        let match = maskedText.match(/\S/);
        if (typeof match?.index === 'number') {
            return {
                value: this.document.positionAt(match.index),
                before: true
            };
        }

        const endTrimmedTextLength = this.text().trimEnd().length;
        return {
            value: this.document.positionAt(endTrimmedTextLength),
            after: endTrimmedTextLength !== 0
        };
    }
}


export interface ProposedPosition
{
    value: vscode.Position;
    before?: boolean;
    after?: boolean;
    nextTo?: boolean;   // Signals not to put a blank line between.
}


// DocumentSymbol ranges don't always include the final semi-colon.
function getEndOfStatement(position: vscode.Position, document: vscode.TextDocument): vscode.Position
{
    let nextPosition = position.translate(0, 1);
    while (document.getText(new vscode.Range(position, nextPosition)) === ';') {
        position = nextPosition;
        nextPosition = position.translate(0, 1);
    }
    return position;
}

function maskUnimportantText(source: string, maskChar: string = ' '): string
{
    const replacer = (match: string) => maskChar.repeat(match.length);
    // Mask comments
    source = source.replace(/(?<=\/\*)(\*(?=\/)|[^*])*(?=\*\/)/g, replacer);
    source = source.replace(/(?<=\/\/).*/g, replacer);
    // Mask quoted characters
    source = source.replace(/(?<=").*(?=")(?<!\\)/g, replacer);
    source = source.replace(/(?<=').*(?=')(?<!\\)/g, replacer);
    // Mask template arguments
    source = source.replace(/(?<=<)(>(?=>)|[^>])*(?=>)/g, replacer);

    return source;
}

function stripDefaultValues(parameters: string): string
{
    parameters = parameters.replace(/[^\w\s]=/g, '');
    parameters = parameters.replace(/\b\s*=\s*\b/g, '=');
    parameters = parameters.replace(/\(\)/g, '');

    let maskedParameters = maskUnimportantText(parameters).split(',');
    let strippedParameters = '';
    let charPos = 0;
    for (const maskedParameter of maskedParameters) {
        if (maskedParameter.includes('=')) {
            strippedParameters += parameters.substring(charPos, charPos + maskedParameter.indexOf('=')) + ',';
        } else {
            strippedParameters += parameters.substring(charPos, charPos + maskedParameter.length) + ',';
        }
        charPos += maskedParameter.length + 1;
    }

    return strippedParameters.substring(0, strippedParameters.length - 1);
}

async function findDefinitionInWorkspace(
    position: vscode.Position,
    uri: vscode.Uri
): Promise<vscode.Location | undefined> {
    const definitionResults = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider', uri, position);

    if (!definitionResults) {
        return;
    }

    for (const result of definitionResults) {
        const location = result instanceof vscode.Location ?
                result : new vscode.Location(result.targetUri, result.targetRange);

        if (location.uri.path === uri.path && !location.range.contains(position)) {
            return location;
        } else if (location.uri.path !== uri.path && vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                if (location.uri.path.includes(folder.uri.path)) {
                    return location;
                }
            }
        }
    }
}
