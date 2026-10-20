/**
 * Copyright (c) Bucher + Suter.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface PluginOptions {
  concurrency?: number;
  addDownloadButton?: boolean;
  autoBuildPdfs?: boolean;
  downloadButtonText?: string;
  ignoreDocs?: string[];
  stylesheets?: string[];
  alwaysIncludeSiteStyles?: boolean;
  scripts?: string[];
  coverPageHeader?: string;
  coverPageFooter?: string;
  getPdfCoverPage?: PageFunction;
  getPdfPageHeader?: PageFunction;
  getPdfPageFooter?: PageFunction;
  margins?: Margins;
  coverMargins?: Margins;
  author?: string;
  /**
   * @deprecated Ignored since 3.6.5. TOC page numbers are read from a render of the final layout,
   * so no footer text has to be parsed any more. Still accepted for backwards compatibility.
   */
  footerParser?: RegExp;
  keepDebugHtmls?: boolean;
  puppeteerTimeout?: number;
  sidebarNames?: string[];
  versions?: string[];
  productVersion?: string;
  subfolders?: string[];
  productTitles?: string[];
  useExtraPaths?: UsePath[];
  ignoreCssSelectors?: string[];
  getPdfFileName?: FileNameFunction;
  /**
   * Per-sidebar document title, as a string or a locale → title map. Replaces the projectName as
   * the root label and file name of that sidebar's PDF.
   */
  sidebarTitles?: Record<string, LocalizedString>;
  /**
   * Generate one PDF over all sidebars and list it as the "complete version" on every page,
   * including the site root. false = off.
   */
  completePdf?: false | CompletePdfOptions;
  /**
   * Structure the PDFs like the sidebar: every page sits at its sidebar depth (headings shift down
   * accordingly), categories without a page get a heading, page titles drop the parent titles in
   * front, and the TOC and the bookmarks nest along the sidebar. false keeps one flat level per page.
   */
  structureBySidebar?: boolean;
}

/** A plain string, or a map from locale (e.g. "en", "de") to the string for that locale. */
export type LocalizedString = string | Record<string, string>;

export type CompletePdfOptions = {
  /** Title of the complete PDF (cover page, page header, download menu). */
  title: LocalizedString;
  /** File name without extension, default "complete". */
  fileName?: string;
};

export type PapersaurusPluginOptions = Required<PluginOptions>;

export type PageFunction = (
  siteConfig: any,
  pluginConfig: PapersaurusPluginOptions,
  pageTitle: string,
  version: string,
  language: string
) => string;

export type FileNameFunction = (
  siteConfig: any,
  pluginConfig: PapersaurusPluginOptions,
  pageTitle: string,
  pageId: string,
  parentTitles: string[],
  parentIds: string[],
  version: string,
  versionPath: string,
  language: string
) => string;

export type UsePath = {
  serverPath: string,
  localPath: string
};

export type TocInfo = {
  link: string,
  href: string,
  text: string
}

export type Margins = {
  top: string,
  right: string,
  bottom: string,
  left: string
}
