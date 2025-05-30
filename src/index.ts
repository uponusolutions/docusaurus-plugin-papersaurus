/**
 * Copyright (c) Bucher + Suter.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { LoadContext, Plugin } from '@docusaurus/types';
import { generatePdfFiles } from './generate';
import { PluginOptions, PapersaurusPluginOptions } from './types';
import { processOptions } from './validateOptions';
import path from 'path';


export default function (
  _context: LoadContext,
  options?: PluginOptions,
): Plugin<void> {

  let pluginOptions: PapersaurusPluginOptions = processOptions(options);

  const res: Plugin<void> = {

    name: 'docusaurus-plugin-papersaurus',

    async postBuild(props) {
      let forceBuild = process.env.BUILD_PDF || "";
      if ((pluginOptions.autoBuildPdfs && !forceBuild.startsWith("0")) || forceBuild.startsWith("1")) {
        await generatePdfFiles(_context.outDir, pluginOptions, props, _context.i18n.currentLocale);
      }
    },

  };
  if (pluginOptions.addDownloadButton) {
    res.getClientModules = () => {
      return [
        path.join(__dirname, 'client.js'),
      ];
    }
  }

  return res
}

export { validateOptions } from "./validateOptions";
