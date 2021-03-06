/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  BuildEvent,
  Builder,
  BuilderConfiguration,
  BuilderContext,
} from '@angular-devkit/architect';
import { Path, getSystemPath, normalize, resolve, virtualFs } from '@angular-devkit/core';
import * as fs from 'fs';
import * as path from 'path';
import { Observable } from 'rxjs';
import { concatMap, map } from 'rxjs/operators';
import * as webpack from 'webpack';
import { WebpackConfigOptions } from '../angular-cli-files/models/build-options';
import {
  getAotConfig,
  getCommonConfig,
  getStylesConfig,
} from '../angular-cli-files/models/webpack-configs';
import { getWebpackStatsConfig } from '../angular-cli-files/models/webpack-configs/utils';
import { readTsconfig } from '../angular-cli-files/utilities/read-tsconfig';
import { statsErrorsToString, statsWarningsToString } from '../angular-cli-files/utilities/stats';
import { BrowserBuilderSchema } from '../browser/schema';
const MemoryFS = require('memory-fs');
const webpackMerge = require('webpack-merge');


export interface ExtractI18nBuilderOptions {
  browserTarget: string;
  i18nFormat: string;
  i18nLocale: string;
  outputPath?: string;
  outFile?: string;
}

export class ExtractI18nBuilder implements Builder<ExtractI18nBuilderOptions> {

  constructor(public context: BuilderContext) { }

  run(builderConfig: BuilderConfiguration<ExtractI18nBuilderOptions>): Observable<BuildEvent> {
    const architect = this.context.architect;
    const options = builderConfig.options;
    const root = this.context.workspace.root;
    const projectRoot = resolve(root, builderConfig.root);
    const [project, targetName, configuration] = options.browserTarget.split(':');
    // Override browser build watch setting.
    const overrides = { watch: false };

    const browserTargetSpec = { project, target: targetName, configuration, overrides };
    const browserBuilderConfig = architect.getBuilderConfiguration<BrowserBuilderSchema>(
      browserTargetSpec);

    return architect.getBuilderDescription(browserBuilderConfig).pipe(
      concatMap(browserDescription =>
        architect.validateBuilderOptions(browserBuilderConfig, browserDescription)),
      map(browserBuilderConfig => browserBuilderConfig.options),
      concatMap((validatedBrowserOptions) => new Observable(obs => {
        const browserOptions = validatedBrowserOptions;

        // We need to determine the outFile name so that AngularCompiler can retrieve it.
        let outFile = options.outFile || getI18nOutfile(options.i18nFormat);
        if (options.outputPath) {
          // AngularCompilerPlugin doesn't support genDir so we have to adjust outFile instead.
          outFile = path.join(options.outputPath, outFile);
        }

        // Extracting i18n uses the browser target webpack config with some specific options.
        const webpackConfig = this.buildWebpackConfig(root, projectRoot, {
          ...browserOptions,
          optimization: false,
          i18nLocale: options.i18nLocale,
          i18nFormat: options.i18nFormat,
          i18nFile: outFile,
          aot: true,
          assets: [],
          scripts: [],
          styles: [],
        });

        const webpackCompiler = webpack(webpackConfig);
        webpackCompiler.outputFileSystem = new MemoryFS();
        const statsConfig = getWebpackStatsConfig();

        const callback: webpack.compiler.CompilerCallback = (err, stats) => {
          if (err) {
            return obs.error(err);
          }

          const json = stats.toJson('verbose');
          if (stats.hasWarnings()) {
            this.context.logger.warn(statsWarningsToString(json, statsConfig));
          }

          if (stats.hasErrors()) {
            this.context.logger.error(statsErrorsToString(json, statsConfig));
          }

          obs.next({ success: !stats.hasErrors() });

          obs.complete();
        };

        try {
          webpackCompiler.run(callback);
        } catch (err) {
          if (err) {
            this.context.logger.error(
              '\nAn error occured during the extraction:\n' + ((err && err.stack) || err));
          }
          throw err;
        }
      })),
    );
  }

  buildWebpackConfig(
    root: Path,
    projectRoot: Path,
    options: BrowserBuilderSchema,
  ) {
    let wco: WebpackConfigOptions;

    const host = new virtualFs.AliasHost(this.context.host as virtualFs.Host<fs.Stats>);

    const tsConfigPath = getSystemPath(normalize(resolve(root, normalize(options.tsConfig))));
    const tsConfig = readTsconfig(tsConfigPath);

    wco = {
      root: getSystemPath(root),
      projectRoot: getSystemPath(projectRoot),
      // TODO: use only this.options, it contains all flags and configs items already.
      buildOptions: options,
      tsConfig,
      tsConfigPath,
      supportES2015: false,
    };

    const webpackConfigs: {}[] = [
      getCommonConfig(wco),
      getAotConfig(wco, host, true),
      getStylesConfig(wco),
    ];

    return webpackMerge(webpackConfigs);
  }
}

function getI18nOutfile(format: string) {
  switch (format) {
    case 'xmb':
      return 'messages.xmb';
    case 'xlf':
    case 'xlif':
    case 'xliff':
    case 'xlf2':
    case 'xliff2':
      return 'messages.xlf';
    default:
      throw new Error(`Unsupported format "${format}"`);
  }
}

export default ExtractI18nBuilder;
