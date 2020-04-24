import { extname } from 'path'
import { workspace, commands, window, EventEmitter, Event, ExtensionContext, ConfigurationChangeEvent } from 'vscode'
import { uniq } from 'lodash'
import { ParsePathMatcher } from '../utils/PathMatcher'
import { EXT_NAMESPACE } from '../meta'
import { ConfigLocalesGuide } from '../commands/configLocalePaths'
import { AvaliablePasers, DefaultEnabledParsers } from '../parsers'
import { Log, getExtOfLanguageId, normalizeUsageMatchRegex } from '../utils'
import { Framework } from '../frameworks/base'
import { getEnabledFrameworks, getEnabledFrameworksByIds, getPackageDependencies } from '../frameworks'
import { checkNotification, clearNotificationState } from '../update-notification'
import { Reviews } from './Review'
import { CurrentFile } from './CurrentFile'
import { Config } from './Config'
import { DirStructure, OptionalFeatures } from './types'
import { LocaleLoader } from './loaders/LocaleLoader'
import { Analyst } from './Analyst'

export class Global {
  private static _loaders: Record<string, LocaleLoader> = {}
  private static _rootpath: string
  private static _enabled = false

  static context: ExtensionContext
  static enabledFrameworks: Framework[] = []
  static reviews = new Reviews()

  // events
  private static _onDidChangeRootPath: EventEmitter<string> = new EventEmitter()
  private static _onDidChangeEnabled: EventEmitter<boolean> = new EventEmitter()
  private static _onDidChangeLoader: EventEmitter<LocaleLoader> = new EventEmitter()

  static readonly onDidChangeRootPath: Event<string> = Global._onDidChangeRootPath.event
  static readonly onDidChangeEnabled: Event<boolean> = Global._onDidChangeEnabled.event
  static readonly onDidChangeLoader: Event<LocaleLoader> = Global._onDidChangeLoader.event

  static async init(context: ExtensionContext) {
    this.context = context

    context.subscriptions.push(workspace.onDidChangeWorkspaceFolders(e => this.updateRootPath()))
    context.subscriptions.push(window.onDidChangeActiveTextEditor(e => this.updateRootPath()))
    context.subscriptions.push(workspace.onDidOpenTextDocument(e => this.updateRootPath()))
    context.subscriptions.push(workspace.onDidCloseTextDocument(e => this.updateRootPath()))
    context.subscriptions.push(workspace.onDidChangeConfiguration(e => this.update(e)))
    await this.updateRootPath()
  }

  static resetCache() {
    this._cacheUsageMatchRegex = {}
  }

  private static _cacheUsageMatchRegex: Record<string, RegExp[]> = {}

  static getUsageMatchRegex(languageId?: string, filepath?: string): RegExp[] {
    if (Config.regexUsageMatch) {
      if (!this._cacheUsageMatchRegex.custom)
        this._cacheUsageMatchRegex.custom = normalizeUsageMatchRegex([...Config.regexUsageMatch, ...Config.regexUsageMatchAppend])
      return this._cacheUsageMatchRegex.custom
    }
    else {
      const key = `${languageId}_${filepath}`
      if (!this._cacheUsageMatchRegex[key]) {
        this._cacheUsageMatchRegex[key] = normalizeUsageMatchRegex([
          ...this.enabledFrameworks.flatMap(f => f.getUsageMatchRegex(languageId, filepath)),
          ...Config.regexUsageMatchAppend,
        ])
      }
      return this._cacheUsageMatchRegex[key]
    }
  }

  static refactorTemplates(keypath: string, languageId?: string) {
    return uniq(this.enabledFrameworks.flatMap(f => f.refactorTemplates(keypath, languageId)))
  }

  static isLanguageIdSupported(languageId: string) {
    return this.enabledFrameworks
      .flatMap(f => f.languageIds as string[])
      .includes(languageId)
  }

  static getSupportLangGlob() {
    const exts = uniq(this.enabledFrameworks
      .flatMap(f => f.languageIds)
      .flatMap(id => getExtOfLanguageId(id)))

    return `**/*.{${exts.join(',')}}`
  }

  static get derivedKeyRules() {
    const rules = Config.usageDerivedKeyRules
      ? Config.usageDerivedKeyRules
      : this.enabledFrameworks
        .flatMap(f => f.derivedKeyRules || [])

    return uniq(rules)
      .map((rule) => {
        const reg = rule
          .replace(/\./g, '\\.')
          .replace(/{key}/, '(.+)')

        return new RegExp(`^${reg}$`)
      })
  }

  static getDocumentSelectors() {
    return this.enabledFrameworks
      .flatMap(f => f.languageIds)
      .map(id => ({ scheme: 'file', language: id }))
  }

  static get enabledParserExts() {
    return this.enabledParsers
      .map(f => f.supportedExts)
      .join('|')
  }

  static getPathMatchers(dirStructure: DirStructure) {
    const rules = Config.pathMatcher
      ? [Config.pathMatcher]
      : this.enabledFrameworks
        .flatMap(f => f.pathMatcher(dirStructure))

    return uniq(rules)
      .map(reg => reg instanceof RegExp ? reg : ParsePathMatcher(reg, this.enabledParserExts))
  }

  static hasFeatureEnabled(name: keyof OptionalFeatures) {
    return this.enabledFrameworks
      .map(i => i.enableFeatures)
      .filter(i => i)
      .some(i => i && i[name])
  }

  static get namespaceEnabled() {
    return Config.namespace || this.hasFeatureEnabled('namespace')
  }

  static get rootpath() {
    return this._rootpath
  }

  private static async initLoader(rootpath: string, reload = false) {
    if (!rootpath)
      return

    if (Config.debug)
      clearNotificationState(this.context)
    checkNotification(this.context)

    if (this._loaders[rootpath] && !reload)
      return this._loaders[rootpath]

    const loader = new LocaleLoader(rootpath)
    await loader.init()
    this.context.subscriptions.push(loader.onDidChange(() => this._onDidChangeLoader.fire(loader)))
    this.context.subscriptions.push(loader)
    this._loaders[rootpath] = loader

    return this._loaders[rootpath]
  }

  private static async updateRootPath() {
    const editor = window.activeTextEditor
    let rootpath = ''

    if (!editor || !workspace.workspaceFolders || workspace.workspaceFolders.length === 0)
      return

    const resource = editor.document.uri
    if (resource.scheme === 'file') {
      const folder = workspace.getWorkspaceFolder(resource)
      if (folder)
        rootpath = folder.uri.fsPath
    }

    if (!rootpath && workspace.rootPath)
      rootpath = workspace.rootPath

    if (rootpath && rootpath !== this._rootpath) {
      this._rootpath = rootpath

      Log.divider()
      Log.info(`💼 Workspace root changed to "${rootpath}"`)

      await this.update()
      this._onDidChangeRootPath.fire(rootpath)
      this.reviews.init(rootpath)
    }
  }

  static async update(e?: ConfigurationChangeEvent) {
    this.resetCache()

    let reload = false
    if (e) {
      let affected = false

      for (const config of Config.reloadConfigs) {
        const key = `${EXT_NAMESPACE}.${config}`
        if (e.affectsConfiguration(key)) {
          affected = true
          reload = true
          Log.info(`🧰 Config "${key}" changed, reloading`)
          break
        }
      }

      for (const config of Config.refreshConfigs) {
        const key = `${EXT_NAMESPACE}.${config}`
        if (e.affectsConfiguration(key)) {
          affected = true
          Log.info(`🧰 Config "${key}" changed`)
          break
        }
      }

      for (const config of Config.usageRefreshConfigs) {
        const key = `${EXT_NAMESPACE}.${config}`
        if (e.affectsConfiguration(key)) {
          Analyst.refresh()

          Log.info(`🧰 Config "${key}" changed`)
          break
        }
      }

      if (!affected)
        return

      if (reload)
        Log.info('🔁 Reloading loader')
    }

    if (!Config.enabledFrameworks) {
      const packages = getPackageDependencies(this._rootpath)
      this.enabledFrameworks = getEnabledFrameworks(packages, this._rootpath)
    }
    else {
      const frameworks = Config.enabledFrameworks
      this.enabledFrameworks = getEnabledFrameworksByIds(frameworks, this._rootpath)
    }
    const isValidProject = this.enabledFrameworks.length > 0
    const hasLocalesSet = Config.localesPaths.length > 0
    const shouldEnabled = isValidProject && hasLocalesSet
    this.setEnabled(shouldEnabled)

    if (this.enabled) {
      Log.info(`🧩 Enabled frameworks: ${this.enabledFrameworks.map(i => i.display).join(', ')}`)
      Log.info(`🧬 Enabled parsers: ${this.enabledParsers.map(i => i.id).join(', ')}`)
      Log.info('')
      await this.initLoader(this._rootpath, reload)
    }
    else {
      if (!isValidProject)
        Log.info('⚠ Current workspace is not a valid project, extension disabled')
      else if (!hasLocalesSet)
        Log.info('⚠ No locales path setting found, extension disabled')

      if (isValidProject && !hasLocalesSet)
        ConfigLocalesGuide.autoSet()

      this.unloadAll()
    }

    this._onDidChangeLoader.fire(this.loader)
  }

  private static unloadAll() {
    Object.values(this._loaders).forEach(loader => loader.dispose())
    this._loaders = {}
  }

  static get loader() {
    return this._loaders[this._rootpath]
  }

  static get enabledParsers() {
    let ids = Config.enabledParsers?.length
      ? Config.enabledParsers
      : this.enabledFrameworks
        .flatMap(f => f.enabledParsers || [])

    if (!ids.length)
      ids = DefaultEnabledParsers

    return AvaliablePasers.filter(i => ids.includes(i.id))
  }

  static getMatchedParser(ext: string) {
    if (!ext.startsWith('.') && ext.includes('.'))
      ext = extname(ext)
    return this.enabledParsers.find(parser => parser.supports(ext))
  }

  // enables
  static get enabled() {
    return this._enabled
  }

  private static setEnabled(value: boolean) {
    if (this._enabled !== value) {
      Log.info(value ? '🌞 Enabled' : '🌚 Disabled')
      this._enabled = value
      commands.executeCommand('setContext', `${EXT_NAMESPACE}-enabled`, value)
      this._onDidChangeEnabled.fire()
    }
  }

  static get allLocales() {
    return CurrentFile.loader.locales
  }

  static get visibleLocales() {
    return this.getVisibleLocales(this.allLocales)
  }

  static getVisibleLocales(locales: string[]) {
    const ignored = Config.ignoredLocales
    return locales.filter(locale => !ignored.includes(locale))
  }
}
