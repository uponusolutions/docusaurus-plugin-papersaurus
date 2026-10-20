/**
 * Copyright (c) Bucher + Suter.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  PapersaurusPluginOptions,
  PdfPart,
  TocInfo,
} from './types';
import { Props, LoadedPlugin } from '@docusaurus/types';
import { LoadedContent, LoadedVersion, DocMetadata } from "@docusaurus/plugin-content-docs"
import puppeteer = require('puppeteer');
// @ts-expect-error no types
import toc = require('html-toc');
import pdfParse from 'pdf-parse-new';
import PQueue from 'p-queue';

const join = require('path').join;
import express = require('express');
import { AddressInfo } from 'net';
import * as fs from 'fs-extra';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFString, PDFHexString } from 'pdf-lib';
import { resolveLocalized } from './i18n';

// github-slugger 2 is ESM-only: plain require() returns the namespace, Docusaurus' loader the class
const githubSluggerModule = require('github-slugger');
const GithubSlugger = githubSluggerModule.default ?? githubSluggerModule;
const cheerio = require('cheerio');

let slugger = new GithubSlugger();

const pluginLogPrefix = '[papersaurus] ';

type LinkEntry = { label: string, file: string, type: 'root' | 'section' | 'chapter' };

/** Queues one PDF render; `file` names the PDF in log and error messages. */
type EnqueueFn = (file: string, task: () => Promise<void>) => void;

/**
 * One part of a PDF: a page (`item`) or, with structureBySidebar, the heading of a category without
 * a page (`heading`). `depth` is the sidebar depth relative to the PDF's root (0 = top level).
 */
type ArticleRef = { item?: any, heading?: string, depth: number };

export async function generatePdfFiles(
  outDir: string,
  pluginOptions: PapersaurusPluginOptions,
  { siteConfig, plugins }: Props,
  language: string) {

  const queue = new PQueue({concurrency: pluginOptions.concurrency ?? 1});

  console.log(`${pluginLogPrefix}Execute generatePdfFiles...`);

  if (!plugins) {
    throw new Error(`${pluginLogPrefix}No docs plugin found.`);
  }

  const docsPlugins = plugins.filter(
    (item) => item.name === "docusaurus-plugin-content-docs"
  );
  if (docsPlugins.length > 1 || docsPlugins.length == 0) {
    throw new Error(`${pluginLogPrefix}Too many or too few docs plugins found, only 1 is supported.`);
  }
  let docPlugin: LoadedPlugin = docsPlugins[0];

  // Check if docusaurus build directory exists
  const docusaurusBuildDir = outDir;
  if (!fs.existsSync(docusaurusBuildDir) ||
    !fs.existsSync(join(docusaurusBuildDir, 'index.html')) ||
    !fs.existsSync(join(docusaurusBuildDir, '404.html'))) {
    throw new Error(
      `${pluginLogPrefix}Could not find a valid docusaurus build directory at "${docusaurusBuildDir}". ` +
      'Did you run "docusaurus build" before?'
    );
  }

  // Check pdf build directory and clean if requested
  const pdfPath = 'pdfs';
  const pdfBuildDir = join(docusaurusBuildDir, pdfPath);
  fs.ensureDirSync(pdfBuildDir);
  console.log(`${pluginLogPrefix}Clean pdf build folder '${pdfBuildDir}'`);
  fs.emptyDirSync(pdfBuildDir);

  // Start local webserver and host files in docusaurus build folder
  const app = express();
  const httpServer = await app.listen();
  const address = httpServer.address();
  if (!address || !isAddressInfo(address)) {
    httpServer.close();
    throw new Error(`${pluginLogPrefix}Something went wrong spinning up the express webserver.`);
  }
  app.use(siteConfig.baseUrl, express.static(docusaurusBuildDir));
  for (const extraUsePath of pluginOptions.useExtraPaths) {
    let localPath = extraUsePath.localPath;
    if (localPath == '..') {
      localPath = join(docusaurusBuildDir, localPath);
    }
    app.use(extraUsePath.serverPath, express.static(localPath));
  }
  const siteAddress = `http://127.0.0.1:${address.port}${siteConfig.baseUrl}`;
  console.log(`${pluginLogPrefix}Server started at ${siteAddress}`);

  // Start a puppeteer browser
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'] });

  const linkToFile: { [key: string]: LinkEntry[] } = {};

  // Every render runs in the queue. Failures are collected, so the build fails with the names of
  // the PDFs that could not be created instead of an unhandled rejection.
  const tasks: Promise<void>[] = [];
  const failures: string[] = [];
  const enqueue: EnqueueFn = (file, task) => {
    // A render can stall when the machine is busy (Chrome stops answering), so retry once before
    // failing the build
    const taskWithRetry = async () => {
      try {
        await task();
      }
      catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`${pluginLogPrefix}Retrying ${file} after: ${message}`);
        await task();
      }
    };
    tasks.push(queue.add(taskWithRetry).then(() => undefined, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${pluginLogPrefix}Failed to create ${file}: ${message}`);
      failures.push(`${file}: ${message}`);
    }));
  };

  try {
    const loadedVersions = (docPlugin.content as LoadedContent).loadedVersions;

    // Loop through all found versions
    for (const versionInfo of loadedVersions) {
      if (pluginOptions.versions.length != 0 && !pluginOptions.versions.includes(versionInfo.versionName)) {
        // Skip this version as it was not specified in versions option.
        continue;
      }

      console.log(`${pluginLogPrefix}Processing version '${versionInfo.label}'`);

      if (pluginOptions.sidebarNames.length == 0) {
        // No sidebar specified, use all of them.
        let allSidebarNames: string[] = [];
        for (const name in versionInfo.sidebars) {
          allSidebarNames.push(name);
        }
        pluginOptions.sidebarNames = allSidebarNames;
      }

      const versionPath = getVersionPath(versionInfo, siteConfig);

      let productVersion = "";
      if (loadedVersions.length === 1) {
        productVersion = pluginOptions.productVersion;
      }

      // Articles of all sidebars (for the complete PDF) and the root category of each sidebar
      const allArticles: ArticleRef[] = [];
      const sidebarRoots: any[] = [];

      // Loop through all configured sidebar names
      for (const [i, sidebarName] of pluginOptions.sidebarNames.entries()) {

        slugger = new GithubSlugger();
        let folderName = '';
        let productTitle = '';

        if (pluginOptions.productTitles && pluginOptions.productTitles.length > i) {
          productTitle = pluginOptions.productTitles[i];
        }

        if (pluginOptions.subfolders && pluginOptions.subfolders.length > i) {
          folderName = pluginOptions.subfolders[i];
        }

        // Create build folder for that version
        const versionPdfPath = [pdfPath, versionPath, folderName].filter(str => str != "").join("/");
        const versionBuildDir = join(pdfBuildDir, versionPath, folderName);
        fs.ensureDirSync(versionBuildDir);

        console.log(`${pluginLogPrefix}Start processing sidebar named '${sidebarName}' in version '${versionInfo.label}'`);

        let sidebar = versionInfo.sidebars[sidebarName];
        if (sidebar) {
          // The root title names the sidebar's PDF; the language-neutral id keeps its file name
          // stable across locales and apart from the sidebar's own index doc.
          const rootTitle = resolveLocalized(pluginOptions.sidebarTitles[sidebarName], language) ?? sidebarName;

          // Create a fake category with root of sidebar
          const rootCategory: any = {
            type: 'category',
            label: rootTitle,
            unversionedId: `${sidebarName.replace(/sidebar$/i, '')}-complete`,
            items: sidebar,
            collapsed: true,
            collapsible: true
          };

          // Browse through all documents of this sidebar
          pickHtmlArticlesRecursive(rootCategory, [], versionInfo, `${siteAddress}docs/`, docusaurusBuildDir, siteConfig, !pluginOptions.structureBySidebar);

          // Create all PDF files for this sidebar
          const sidebarArticles = await createPdfFilesRecursive(
            enqueue,
            language,
            rootCategory,
            [],
            [],
            versionInfo,
            pluginOptions,
            siteConfig,
            versionBuildDir,
            versionPdfPath,
            browser,
            siteAddress,
            productTitle,
            productVersion
          );

          allArticles.push(...sidebarArticles);
          sidebarRoots.push(rootCategory);
        }
        else {
          console.log(`${pluginLogPrefix}Sidebar '${sidebarName}' doesn't exist in version '${versionInfo.label}', continue without it...`);
        }

      }

      // One PDF over all sidebars, offered as the "complete version" on every page
      let completeEntry: LinkEntry | undefined;
      if (pluginOptions.completePdf && allArticles.length > 0) {
        const title = resolveLocalized(pluginOptions.completePdf.title, language) ?? siteConfig.projectName ?? 'Unnamed project';
        const fileName: string = new GithubSlugger().slug(pluginOptions.completePdf.fileName ?? 'complete');
        const outputDir = join(pdfBuildDir, versionPath);
        fs.ensureDirSync(outputDir);
        const file = `${[pdfPath, versionPath].filter(str => str != "").join("/")}/${fileName}.pdf`;

        enqueue(file, () => createPdfFromArticles(
          language,
          title,
          productVersion || versionInfo.label,
          fileName,
          allArticles,
          pluginOptions,
          siteConfig,
          outputDir,
          browser,
          siteAddress
        ));

        completeEntry = { label: title, file, type: 'root' };

        if (versionInfo.isLast) {
          // The site root is in no sidebar; give it the complete PDF so the button shows there too
          linkToFile[stripTrailingSlash(siteConfig.baseUrl)] = [completeEntry];
        }
      }

      // Save url to filename mappings
      for (const rootCategory of sidebarRoots) {
        const rootEntry: LinkEntry = {
          label: rootCategory.label,
          file: rootCategory.pdfFilename,
          type: completeEntry ? 'section' : 'root'
        };
        saveUrlToFileMappingsRecursive(rootCategory.items, linkToFile, completeEntry ? [completeEntry, rootEntry] : [rootEntry]);
      }
    }

    fs.writeFileSync(join(docusaurusBuildDir, 'pdfs.json'), JSON.stringify(linkToFile));

    await queue.onIdle();
    await Promise.all(tasks);
  }
  finally {
    console.log("close browser")
    await browser.close();

    await new Promise((res)=>{
        httpServer.close(res);
    })
  }

  if (failures.length > 0) {
    throw new Error(`${pluginLogPrefix}${failures.length} PDF file(s) could not be created:\n${failures.join('\n')}`);
  }

  console.log(`${pluginLogPrefix}generatePdfFiles finished!`);
}

function stripTrailingSlash (str: string) {
  return str.endsWith('/') ?
    str.slice(0, -1) : str;
};

function saveUrlToFileMappingsRecursive(
  sideBarItems: any[],
  output: { [key: string]: LinkEntry[] },
  parents: LinkEntry[] = []) {

  for (const item of sideBarItems) {
    if (item.permalink) {
      output[stripTrailingSlash(item.permalink)] = [...parents, {
        label: item.label,
        file: item.pdfFilename,
        type: 'chapter'
      }];
    }

    if (item.items) {
      saveUrlToFileMappingsRecursive(item.items, output, [...parents, {
        label: item.label,
        file: item.pdfFilename,
        type: 'section'
      }]);
    }
  }
};

function getUnversionedId(id: string): string {
  const ids = id.split("/")
  let unversionedId = ids.pop()!
  if(unversionedId == "index" && ids.length>0) {
    unversionedId = ids.pop()!
  }
  return unversionedId
}

function pickHtmlArticlesRecursive(sideBarItem: any,
  parentTitles: string[],
  version: LoadedVersion,
  rootDocUrl: string,
  htmlDir: string,
  siteConfig: any,
  prefixParentTitles: boolean) {
  switch (sideBarItem.type) {
    case 'category': {
      const hasDocLink = sideBarItem.link && sideBarItem.link.type == 'doc';
      if (hasDocLink) {
        let path = htmlDir;
        for (const doc of version.docs) {
          if (doc.id == sideBarItem.link.id) {
            sideBarItem.id = doc.id;
            sideBarItem.unversionedId = getUnversionedId(doc.id);
            sideBarItem.permalink = doc.permalink;
            path = join(path, getPermaLink(doc, siteConfig));
            break;
          }
        }
        readHtmlForItem(sideBarItem, parentTitles, rootDocUrl, path, version, siteConfig, prefixParentTitles);
      }
      else {
        console.log("a", sideBarItem.label)
        // Keep a preset id (the sidebar roots carry one), else name the category by its label
        sideBarItem.unversionedId = sideBarItem.unversionedId || sideBarItem.label || "untitled";
      }
      const newParentTitles = [...parentTitles];
      newParentTitles.push(sideBarItem.label);
      for (const categorySubItem of sideBarItem.items) {
        pickHtmlArticlesRecursive(categorySubItem, newParentTitles, version, rootDocUrl, htmlDir, siteConfig, prefixParentTitles);
        if (!hasDocLink && !sideBarItem.stylePath) {
          sideBarItem.stylePath = categorySubItem.stylePath;
          sideBarItem.scriptPath = categorySubItem.scriptPath;
        }
      }
      break;
    }
    case 'doc': {
      // Merge properties we need that is specified on the document.
      let path = htmlDir;
      for (const doc of version.docs) {
        if (doc.id == sideBarItem.id) {
          sideBarItem.label = doc.title;
          sideBarItem.unversionedId = getUnversionedId(doc.id);
          sideBarItem.permalink = doc.permalink;
          path = join(path, getPermaLink(doc, siteConfig));
          break;
        }
      }
      readHtmlForItem(sideBarItem, parentTitles, rootDocUrl, path, version, siteConfig, prefixParentTitles);
      break;
    }
    default:
      break;
  }
}

async function createPdfFilesRecursive(enqueue: EnqueueFn,
  language: string,
  sideBarItem: any,
  parentTitles: string[],
  parentIds: string[],
  version: LoadedVersion,
  pluginOptions: PapersaurusPluginOptions,
  siteConfig: any,
  buildDir: string,
  pdfPath: string,
  browser: puppeteer.Browser,
  siteAddress: string,
  productTitle: string,
  productVersion: string
): Promise<ArticleRef[]> {

  // The parts of this item, depth relative to this item
  let articles: ArticleRef[] = [];
  switch (sideBarItem.type) {
    case 'category': {
      if (sideBarItem.permalink) {
        articles.push({ item: sideBarItem, depth: 0 });
      }
      else if (pluginOptions.structureBySidebar) {
        articles.push({ heading: sideBarItem.label || '', depth: 0 });
      }
      const newParentTitles = [...parentTitles];
      newParentTitles.push(sideBarItem.label);
      const newParentIds = [...parentIds];
      newParentIds.push(sideBarItem.unversionedId);
      for (const categorySubItem of sideBarItem.items) {
        const subDocs = await createPdfFilesRecursive(enqueue,
          language,
          categorySubItem,
          newParentTitles,
          newParentIds,
          version,
          pluginOptions,
          siteConfig,
          buildDir,
          pdfPath,
          browser,
          siteAddress,
          productTitle,
          productVersion
        );
        articles.push(...subDocs.map((ref) => ({ ...ref, depth: ref.depth + 1 })));
      }
      break;
    }
    case 'doc': {
      articles.push({ item: sideBarItem, depth: 0 });
      break;
    }
    default:
      break;
  }

  let pdfFilename = pluginOptions.getPdfFileName(siteConfig, pluginOptions, sideBarItem.label, sideBarItem.unversionedId, parentTitles, parentIds, version.versionName, version.path, language);
  pdfFilename = slugger.slug(pdfFilename);

  let documentTitle = sideBarItem.label || '';

  if (parentTitles.length > 1) {
    documentTitle = parentTitles.slice(1).join(' / ') + ' / ' + documentTitle;
  }

  if (productTitle) {
    documentTitle = productTitle + ' / ' + documentTitle;
  }

  // In this item's own PDF the cover names a category without a page, so its heading is left out
  // and everything below moves up one level
  let pdfArticles = articles;
  if (articles.length > 0 && articles[0].heading !== undefined) {
    pdfArticles = articles.slice(1).map((ref) => ({ ...ref, depth: ref.depth - 1 }));
  }

  if (pdfArticles.some((ref) => ref.item)) {
    enqueue(`${pdfPath}/${pdfFilename}.pdf`, () => createPdfFromArticles(
      language,
      documentTitle,
      productVersion || version.label,
      pdfFilename,
      pdfArticles,
      pluginOptions,
      siteConfig,
      buildDir,
      browser,
      siteAddress
    ));
    sideBarItem.pdfFilename = `${pdfPath}/${pdfFilename}.pdf`;
  }

  return articles;
}

function readHtmlForItem(
  item: any,
  parentTitles: string[],
  rootDocUrl: string,
  htmlDir: string,
  version: LoadedVersion,
  siteConfig: any,
  prefixParentTitles: boolean) {

  let htmlFilePath = htmlDir;
  htmlFilePath = join(htmlFilePath, 'index.html');

  let stylePath = '';
  let scriptPath = '';
  let html = '';

  console.log(`${pluginLogPrefix}Reading file ${htmlFilePath}`);

  let htmlFileContent: string = fs.readFileSync(htmlFilePath, { encoding: 'utf8' });

  const origin = (new URL(rootDocUrl)).origin;

  try {
    stylePath = getStylesheetPathFromHTML(htmlFileContent, origin);
  }
  catch {
  }

  try {
    scriptPath = getScriptPathFromHTML(htmlFileContent, origin);
  }
  catch {
  }

  const articleMatch = htmlFileContent.match(/<article>.*<\/article>/s);
  if (articleMatch) {
    html = articleMatch[0];
    const markDownDivPos = html.indexOf('<div class=\"theme-doc-markdown markdown\">');
    const footerPos = html.indexOf('<footer ');
    if (markDownDivPos > 0 && footerPos > markDownDivPos) {
      html = html.substring(markDownDivPos, footerPos);
    }
  }
  html = html.replace(/loading="lazy"/g, 'loading="eager"');

  // Search for title in h1 tag
  let titleMatch = html.match(/<h1 class=".*">.*<\/h1>/s);
  if (!titleMatch) {
    titleMatch = html.match(/<h1>.*<\/h1>/s);
  }
  if (titleMatch) {
    const h1Tag = titleMatch[0];
    // Save found title in item
    item.pageTitle = h1Tag.substring(h1Tag.indexOf('>') + 1, h1Tag.indexOf('</h1>'));

    // Add parent titles in front of existing title in h1 tag
    let newTitle = item.pageTitle;
    if (prefixParentTitles && parentTitles.length > 1) {
      newTitle = parentTitles.slice(1).join(' / ') + ' / ' + item.pageTitle;
    }
    const newH1Tag = h1Tag.substring(0, h1Tag.indexOf('>') + 1) + newTitle + h1Tag.substring(h1Tag.indexOf('</h1>'));
    html = html.replace(h1Tag, newH1Tag);
  }

  html = getHtmlWithAbsoluteLinks(html, version, siteConfig);

  item.articleHtml = html;
  item.scriptPath = scriptPath;
  item.stylePath = stylePath;
  item.parentTitles = parentTitles;

  return;
}

async function createPdfFromArticles(
  language: string,
  documentTitle: string,
  documentVersion: string,
  pdfName: string,
  articleList: ArticleRef[],
  pluginOptions: PapersaurusPluginOptions,
  siteConfig: any,
  buildDir: string,
  browser: puppeteer.Browser,
  siteAddress: string
): Promise<void> {

  const contentHtmlFile = join(buildDir, `${pdfName}.content.html`);
  const finalPdfFile = join(buildDir, `${pdfName}.pdf`);

  console.log(`${pluginLogPrefix}Creating PDF ${finalPdfFile}...`);

  const coverPage = await browser.newPage();
  let titlePdfFile: Uint8Array;
  try {
    await coverPage.setContent(
      pluginOptions.getPdfCoverPage(siteConfig, pluginOptions, documentTitle, documentVersion, language, 'cover'),
      {
        timeout: pluginOptions.puppeteerTimeout
      });
    titlePdfFile = await coverPage.pdf({
      format: 'a4',
      headerTemplate: pluginOptions.coverPageHeader,
      footerTemplate: pluginOptions.coverPageFooter,
      displayHeaderFooter: true,
      printBackground: true,
      margin: pluginOptions.coverMargins,
      timeout: pluginOptions.puppeteerTimeout
    });
  }
  finally {
    await coverPage.close();
  }


  const structured = pluginOptions.structureBySidebar;
  const pages = articleList.filter((ref) => ref.item).map((ref) => ref.item);
  let stylePath = pages[0].stylePath;
  let scriptPath = pages[0].scriptPath;

  let fullHtml = '';
  for (const article of articleList) {
    if (article.item) {
      if (pages.length > 1 && pluginOptions.ignoreDocs.includes(article.item.unversionedId || '-IdIsEmpty-')) {
        // Don't add ignored articles to PDF's with multiple articles (section pdf's, complete document pdf)
        continue;
      }
      fullHtml += structured ? nestHeadings(article.item.articleHtml || '', article.depth) : (article.item.articleHtml || '');
    }
    else if (structured && article.heading) {
      const tag = `h${Math.min(6, article.depth + 1)}`;
      fullHtml += `<${tag} data-toc-level="${article.depth}">${escapeHtml(article.heading)}</${tag}>`;
    }
  }

  // Remove header tags (around h1)
  fullHtml = fullHtml.replace(/<header>/g, '');
  fullHtml = fullHtml.replace(/<header\/>/g, '');

  // Hide hashlinks (replace visible hash with space)
  fullHtml = fullHtml.replace(/">#<\/a>/g, `"> </a>`);

  const $ = cheerio.load(fullHtml);
  if (pluginOptions.ignoreCssSelectors) {
    for (const ignoreSelector of pluginOptions.ignoreCssSelectors) {
      $(ignoreSelector).remove();
    }
  }
  $(".theme-doc-breadcrumbs").remove();
  $(".theme-doc-version-badge").remove();
  $(".theme-doc-toc-mobile").remove();
  $(".buttonGroup__atx").remove();

  let htmlToc: string;
  let htmlArticles: string;

  if (structured) {
    // Table of contents along the logical levels (sidebar depth + heading level), which nest
    // deeper than the h1-h6 tags can
    const entries: TocEntry[] = [];
    $('[data-toc-level]').each((_i: number, el: any) => {
      const text = $(el).text().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      if (!text) {
        return;
      }
      const id = `papersaurus-toc-${entries.length + 1}`;
      $(el).append(`<a class="toc-target" id="${id}"></a>`);
      entries.push({ level: Number($(el).attr('data-toc-level')), id, text });
    });
    htmlArticles = $.html();
    htmlToc = '<h1 class="ignoreCounter">Contents</h1>' + buildNestedToc(entries);
  }
  else {
    fullHtml = $.html();

    // Add table of contents
    fullHtml = toc('<div id="toc"></div>' + fullHtml, {
      anchorTemplate: function (id: string) {
        return `<a class="toc-target" href="${id}" id="${id}"></a>`;
      },
      selectors: 'h1,h2,h3',
      parentLink: false,
      header: '<h1 class="ignoreCounter">Contents</h1>',
      minLength: 0,
      addId: false //=default
    });

    htmlToc = fullHtml.substring(14, fullHtml.indexOf('</div>'));

    htmlToc = htmlToc.replace(/class="nav sidenav"/g, 'class="toc-headings"');
    htmlToc = htmlToc.replace(/class="nav"/g, 'class="toc-headings"');
    htmlToc = htmlToc.replace(/[\r\n]+/g, '');

    htmlArticles = fullHtml.substring(fullHtml.indexOf('</div>') + 6);
  }
  const tocLinks = htmlToc.match(/<a href="#[^<>]+">[^<>]+<\/a>/g);
  let tocLinksInfos = tocLinks?.map((link) => {
    const entry: TocInfo = {
      link: link,
      href: link.substring(link.indexOf('href="') + 6, link.indexOf('">')),
      text: link.substring(link.indexOf('">') + 2, link.indexOf('</a>')),
    }
    return entry;
  });
  tocLinksInfos = tocLinksInfos || [];

  for (const tocLinkInfo of tocLinksInfos) {
    htmlToc = htmlToc.replace(tocLinkInfo.link,
      `<a href="${tocLinkInfo.href}"><span>${tocLinkInfo.text}</span><span class="dotLeader"></span><span class="pageNumber">_</span></a>`);
  }

  let htmlStyles = `<style>
  h1 {
    page-break-before: always;
  }

  .papersaurus-first {
    page-break-before: auto !important;
    break-before: auto !important;
  }

  h1, h2, h3, h4 {
    break-after: avoid;
  }

  img {
    max-width: 100%;
    height: auto;
    break-inside: avoid;
  }

  figure, tr {
    break-inside: avoid;
  }

  .toc-headings a {
    width: 100%;
    display: flex;
  }

  .dotLeader {
    flex-grow: 1;
    margin: 0 0.2cm;
    border-bottom: 2px dotted;
    margin-bottom: 6px;
  }
  .theme-code-block, .theme-admonition {
    break-inside: avoid;
  }
  </style>`;
  const hasCustomStyles = pluginOptions.stylesheets && pluginOptions.stylesheets.length > 0;
  if (hasCustomStyles) {
    for (const stylesheet of pluginOptions.stylesheets) {
      htmlStyles = `${htmlStyles}<link rel="stylesheet" href="${stylesheet}">`;
    }
  }

  if (!hasCustomStyles || pluginOptions.alwaysIncludeSiteStyles) {
    if (stylePath) {
      htmlStyles = `${htmlStyles}<link rel="stylesheet" href="${stylePath}">`;
    }
  }

  let htmlScripts = '';
  if (pluginOptions.scripts && pluginOptions.scripts.length > 0) {
    for (const script of pluginOptions.scripts) {
      htmlScripts = `${htmlScripts}<script src="${script}"></script>`;
    }
  }
  else {
    if (scriptPath) {
      htmlScripts = `${htmlScripts}<script src="${scriptPath}"></script>`;
    }
  }

  const wrapHtml = (body: string) => `
  <!DOCTYPE html>
  <html lang="${language}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="generator" content="Papersaurus">
      ${htmlStyles}
      ${htmlScripts}
    </head>
    <body>
      ${body}
    </body>
  </html>`;

  // Fills the "_" placeholders of the TOC entries, in order, with the given page numbers.
  const fillTocPageNumbers = (tocHtml: string, pageNumbers: number[]) => {
    let index = 0;
    return tocHtml.replace(/<span class="pageNumber">_<\/span>/g, () => {
      const pageNumber = pageNumbers[index++];
      return `<span class="pageNumber">${pageNumber ?? ''}</span>`;
    });
  };

  const page = await browser.newPage();
  let contentPdfFile: Uint8Array;
  let tocPdfFile: Uint8Array | undefined;
  let tocPageNumbers: number[] = [];
  try {
    if (pluginOptions.numberPagesAfterToc) {
      // Content on its own, so its page numbers start at 1. Chrome writes named destinations only
      // for ids a link in the same document points to, so hidden links to the TOC targets go first.
      const targetLinks = tocLinksInfos.map((info) => `<a href="${info.href}">&#8203;</a>`).join('');
      const contentHtml = `<div style="position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden">${targetLinks}</div>`
        + markFirstHeading(htmlArticles);
      contentPdfFile = await renderPdf(wrapHtml(contentHtml), true, 'content');
      tocPageNumbers = getTocContentPages(tocLinksInfos, await getPdfPageTexts(contentPdfFile));

      // TOC on its own; its links become URI links here and are pointed at the content after merging
      const tocHtml = fillTocPageNumbers(htmlToc, tocPageNumbers).replace(/href="#/g, `href="${tocLinkPrefix}`);
      tocPdfFile = await renderPdf(wrapHtml(markFirstHeading(tocHtml)), false, 'toc');
    }
    else {
      // Measuring pass: the final layout (TOC + content) with placeholder page numbers. The page
      // of every heading in it is its final page number, because the numbers only change the width
      // of the TOC lines, not their count. Measuring the final layout directly avoids guessing how
      // many pages the TOC takes or whether a partial document starts with an empty page.
      const measureHtml = wrapHtml(fillTocPageNumbers(htmlToc, tocLinksInfos.map(() => 888)) + htmlArticles);
      const pageNumbers = getTocContentPages(tocLinksInfos, await getPdfPageTexts(await renderPdf(measureHtml, false, 'content')));

      // Final pass: the real numbers, plus the PDF outline (bookmarks).
      const finalHtml = wrapHtml(fillTocPageNumbers(htmlToc, pageNumbers) + htmlArticles);
      contentPdfFile = await renderPdf(finalHtml, true, 'content');
    }

    if (pluginOptions.keepDebugHtmls) {
      fs.writeFileSync(contentHtmlFile, await page.content());
    }
  }
  finally {
    await page.close();
  }

  if (tocPdfFile) {
    const pageOfTarget = new Map<string, number>();
    tocLinksInfos.forEach((info, i) => pageOfTarget.set(info.href.substring(1), tocPageNumbers[i]));
    await mergeWithSeparateToc(titlePdfFile, tocPdfFile, contentPdfFile, pageOfTarget, finalPdfFile);
  }
  else {
    await mergeMultiplePDF([titlePdfFile, contentPdfFile], finalPdfFile);
  }

  async function renderPdf(html: string, outline: boolean, part: PdfPart): Promise<Uint8Array> {
    // Load the site first, so relative URLs in the content resolve against it
    await page.goto(siteAddress, {
      timeout: pluginOptions.puppeteerTimeout
    });
    await page.setContent(html, {
      timeout: pluginOptions.puppeteerTimeout
    });
    return await page.pdf({
      format: 'a4',
      headerTemplate: pluginOptions.getPdfPageHeader(siteConfig, pluginOptions, documentTitle, documentVersion, language, part),
      footerTemplate: pluginOptions.getPdfPageFooter(siteConfig, pluginOptions, documentTitle, documentVersion, language, part),
      displayHeaderFooter: true,
      printBackground: true,
      scale: 1,
      margin: pluginOptions.margins,
      outline: outline,
      timeout: pluginOptions.puppeteerTimeout
    });
  }

  // Merges cover, TOC and content (the base, so its outline and named destinations stay intact)
  // and points the TOC links, rendered as URI links, at their targets in the content.
  async function mergeWithSeparateToc(cover: Uint8Array, toc: Uint8Array, content: Uint8Array, pageOfTarget: Map<string, number>, name: string): Promise<void> {
    const baseDoc = await PDFDocument.load(content);
    removeTocTargetLinks(baseDoc);
    const namedDestinations = getNamedDestinations(baseDoc);

    let insertAt = 0;
    const coverDoc = await PDFDocument.load(cover);
    for (const p of await baseDoc.copyPages(coverDoc, coverDoc.getPageIndices())) {
      baseDoc.insertPage(insertAt++, p);
    }
    const tocDoc = await PDFDocument.load(toc);
    const tocPages = [];
    for (const p of await baseDoc.copyPages(tocDoc, tocDoc.getPageIndices())) {
      baseDoc.insertPage(insertAt++, p);
      tocPages.push(p);
    }
    const firstContentPage = insertAt;

    for (const tocPage of tocPages) {
      const annots = tocPage.node.lookup(PDFName.of('Annots'));
      if (!(annots instanceof PDFArray)) {
        continue;
      }
      for (let i = 0; i < annots.size(); i++) {
        const annot = annots.lookup(i);
        const action = annot instanceof PDFDict ? annot.lookup(PDFName.of('A')) : undefined;
        const uri = action instanceof PDFDict ? action.lookup(PDFName.of('URI')) : undefined;
        const url = uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : '';
        if (!(annot instanceof PDFDict) || !url.startsWith(tocLinkPrefix)) {
          continue;
        }
        const target = url.substring(tocLinkPrefix.length);
        annot.delete(PDFName.of('A'));
        if (namedDestinations.has(target)) {
          annot.set(PDFName.of('Dest'), PDFName.of(target));
        }
        else {
          // no named destination: jump to the top of the target's page
          const pageIndex = Math.min(baseDoc.getPageCount() - 1, firstContentPage + (pageOfTarget.get(target) ?? 1) - 1);
          annot.set(PDFName.of('Dest'), baseDoc.context.obj([baseDoc.getPage(pageIndex).ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]));
        }
      }
    }

    baseDoc.setAuthor(pluginOptions.author);
    baseDoc.setTitle(documentTitle);
    await fs.writeFile(name, await baseDoc.save());
  };

  async function mergeMultiplePDF(pdfFiles: Uint8Array[], name: string): Promise<void> {
    if (pdfFiles.length === 0) {
      throw new Error('mergeMultiplePDF called with no PDF files');
    }

    const baseDoc = await PDFDocument.load(pdfFiles[pdfFiles.length - 1]);
    let insertAt = 0;
    for (let i = 0; i < pdfFiles.length - 1; i++) {
      const frontDoc = await PDFDocument.load(pdfFiles[i]);
      const copied = await baseDoc.copyPages(frontDoc, frontDoc.getPageIndices());
      for (const p of copied) {
        baseDoc.insertPage(insertAt++, p);
      }
    }
    baseDoc.setAuthor(pluginOptions.author);
    baseDoc.setTitle(documentTitle);
    await fs.writeFile(name, await baseDoc.save());
  };
}

type TocEntry = { level: number, id: string, text: string };

/** Prefix of the TOC links while the TOC is rendered on its own (numberPagesAfterToc). */
const tocLinkPrefix = 'https://papersaurus.invalid/toc#';

/**
 * Lets the first heading of a separately rendered part start on the first page: with the site
 * stylesheet, the forced page break of a leading h1 otherwise leaves the first page empty.
 */
const markFirstHeading = (html: string) => {
  const $ = cheerio.load(html, null, false);
  $('h1, h2, h3, h4, h5, h6').first().addClass('papersaurus-first');
  return $.html();
};

/** Names of the named destinations (catalog /Dests dictionary, as Chrome writes them). */
const getNamedDestinations = (doc: PDFDocument): Set<string> => {
  const names = new Set<string>();
  const dests = doc.catalog.lookup(PDFName.of('Dests'));
  if (dests instanceof PDFDict) {
    for (const [key] of dests.entries()) {
      names.add(key.decodeText());
    }
  }
  return names;
};

/** Removes the hidden helper links to the TOC targets from the content. */
const removeTocTargetLinks = (doc: PDFDocument) => {
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) {
      continue;
    }
    const kept = annots.asArray().filter((ref) => {
      const annot = doc.context.lookup(ref);
      const dest = annot instanceof PDFDict ? annot.get(PDFName.of('Dest')) : undefined;
      return !(dest instanceof PDFName && dest.decodeText().startsWith('papersaurus-toc-'));
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj(kept));
  }
};

const escapeHtml = (text: string) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Moves the headings of a page down by its sidebar depth (h1 of a page at depth 2 becomes h3, capped
 * at h6) and marks the page's h1-h3 for the table of contents with their logical level.
 */
const nestHeadings = (html: string, depth: number) => {
  const $ = cheerio.load(html, null, false);
  $('h1, h2, h3, h4, h5, h6').each((_i: number, el: any) => {
    const level = Number(el.name.substring(1));
    el.name = `h${Math.min(6, level + depth)}`;
    if (level <= 3) {
      $(el).attr('data-toc-level', String(level - 1 + depth));
    }
  });
  return $.html();
};

/** Builds nested `ul.toc-headings` lists from entries in document order. */
const buildNestedToc = (entries: TocEntry[]) => {
  let html = '';
  const levels: number[] = [];
  for (const entry of entries) {
    if (levels.length === 0 || entry.level > levels[levels.length - 1]) {
      // first entry, or deeper than the previous one: open a list inside the open item
      html += '<ul class="toc-headings">';
      levels.push(entry.level);
    }
    else {
      while (levels.length > 1 && entry.level < levels[levels.length - 1]) {
        html += '</li></ul>';
        levels.pop();
      }
      html += '</li>';
    }
    html += `<li><a href="#${entry.id}">${escapeHtml(entry.text)}</a>`;
  }
  while (levels.length > 0) {
    html += '</li></ul>';
    levels.pop();
  }
  return html;
};

const escapeHeaderRegex = (header: string) => {
  return header
    // escape all regex reserved characters
    .replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')
    // allow any whitespace, including line breaks, between words
    .replace(/\s+/g, '\\s+');
}

const pdfHeaderRegex = [
  (h1: string) => new RegExp(`^\\d+\\s{2}${escapeHeaderRegex(h1)}(\\s|\\s\\n)?$`, 'gm'),
  (h2: string) => new RegExp(`^\\d+\\.\\d+\\s{2}${escapeHeaderRegex(h2)}(\\s|\\s\\n)?$`, 'gm'),
  (h3: string) => new RegExp(`^\\d+\\.\\d+.\\d+\\s{2}${escapeHeaderRegex(h3)}(\\s|\\s\\n)?$`, 'gm'),
  (unnumbered: string) => new RegExp(`^${escapeHeaderRegex(unnumbered)}$`, 'gm')
];

const getHtmlWithAbsoluteLinks = (html: string, version: LoadedVersion, siteConfig: any) => {
  let versionPath = '';
  if (!version.isLast) {
    versionPath = `${getVersionPath(version, siteConfig)}/`;
  }

  return html.replace(/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/g, function (matched, _p1, p2) {
    if (p2.indexOf('http') === 0) {
      // ignore already external links
      return matched;
    }

    if (p2.indexOf('#') === 0) {
      // ignore anchor links. because we don't know in which file
      // they are. Plus they will allways work (but can have multiple targets when merging)
      return matched;
    }

    if (p2.indexOf('.') === 0) {
      // this is some kind of a manually created link.
      return matched;
    }

    if (p2.indexOf(siteConfig.baseUrl) === 0) {
      return matched.replace(p2, `${siteConfig.url}${p2}`);
    }

    return matched.replace(p2, `${siteConfig.url}${siteConfig.baseUrl}docs/${versionPath}${p2}`);
  });
};

const getVersionPath = (version: LoadedVersion, siteConfig: any) => {
  let versionPath = version.path;
  return versionPath.substring(siteConfig.baseUrl.length, versionPath.length);
};

const getPermaLink = (doc: DocMetadata, siteConfig: any) => {
  let link = doc.permalink;
  return link.substring(siteConfig.baseUrl.length, link.length);
};

const decodeHtml = (str: string) => {
  // Taken from here: https://stackoverflow.com/a/39243641
  const htmlEntities: { [key: string]: string } = {
    nbsp: ' ',
    cent: '¢',
    pound: '£',
    yen: '¥',
    euro: '€',
    copy: '©',
    reg: '®',
    lt: '<',
    gt: '>',
    quot: '"',
    amp: '&',
    apos: '\''
  };

  return str.replace(/\&([^;]+);/g, function (entity, entityCode) {
    var match;

    if (entityCode in htmlEntities) {
      return htmlEntities[entityCode];
      /*eslint no-cond-assign: 0*/
    } else if (match = entityCode.match(/^#x([\da-fA-F]+)$/)) {
      return String.fromCharCode(parseInt(match[1], 16));
      /*eslint no-cond-assign: 0*/
    } else if (match = entityCode.match(/^#(\d+)$/)) {
      return String.fromCharCode(~~match[1]);
    } else {
      return entity;
    }
  })
    // taken from here: https://stackoverflow.com/a/11305926
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/** Extracts the text of every page of a PDF, indexed by page (0-based). */
const getPdfPageTexts = async (pdf: Uint8Array): Promise<string[]> => {
  const pageTexts: string[] = [];
  await pdfParse(Buffer.from(pdf), {
    verbosityLevel: 0,
    // Same line joining as pdf-parse's default renderer, but keeps the text per page
    pagerender: async (pageData: any) => {
      const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY: number | undefined;
      let text = '';
      for (const item of textContent.items) {
        if (lastY === item.transform[5] || !lastY) {
          text += item.str;
        } else {
          text += '\n' + item.str;
        }
        lastY = item.transform[5];
      }
      pageTexts[pageData.pageNumber - 1] = text;
      return text;
    }
  } as any);
  return pageTexts;
};

/**
 * Finds the page (1-based) of every TOC entry in the page texts of the content. Headings are
 * searched in document order from the page of the previous entry; an entry that is not found
 * gets the page of the previous one.
 */
const getTocContentPages = (tocList: TocInfo[], pageTexts: string[]): number[] => {
  const pages: number[] = [];
  let lastPageIndex = 0;
  for (const tocEntry of tocList) {
    const heading = decodeHtml(tocEntry.text).trim();
    for (let pageIndex = lastPageIndex; pageIndex < pageTexts.length; pageIndex++) {
      const pageText = pageTexts[pageIndex] ?? '';
      if (pdfHeaderRegex.some((regex) => regex(heading).test(pageText))) {
        lastPageIndex = pageIndex;
        break;
      }
    }
    pages.push(lastPageIndex + 1);
  }
  return pages;
};

const getURL = (origin: string, filePath: string) => {
  return origin + '/' + filePath.substring(filePath.startsWith('/') ? 1 : 0);
};

const getStylesheetPathFromHTML = (html: string, origin: string) => {
  const regExp = /(?:|<link[^<>]*){1}href="?([^<>]*styles[^<>]*?\.css){1}"?/g;
  let filePath = '';
  try {
    filePath = getFirstCapturingGroup(regExp, html);
  } catch {
    throw new Error(
      "The href attribute of the 'styles*.css' file could not be found!"
    );
  }
  return getURL(origin, filePath);
};

const getScriptPathFromHTML = (html: string, origin: string) => {
  const regExp = /(?:|<script[^<>]*){1}src="?([^<>]*styles[^<>]*?\.js){1}"?/g;
  let filePath = '';
  try {
    filePath = getFirstCapturingGroup(regExp, html);
  } catch {
    throw new Error(
      "The src attribute of the 'styles*.js' file could not be found!"
    );
  }
  return getURL(origin, filePath);
};

const getFirstCapturingGroup = (regExp: RegExp, text: string) => {
  const match = regExp.exec(text);
  if (match && match[1]) {
    return match[1];
  } else {
    throw new ReferenceError('No capture group found in the provided text.');
  }
};

function isObject(x: unknown): x is Record<PropertyKey, unknown> {
  return x !== null && typeof x === 'object';
}

function hasOwnProperty<
  X extends Record<PropertyKey, unknown>,
  Y extends PropertyKey
>(obj: X, prop: Y): obj is X & Record<Y, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

const isAddressInfo = (arg: unknown): arg is AddressInfo => {
  return (
    isObject(arg) &&
    hasOwnProperty(arg, 'address') &&
    typeof arg.address == 'string' &&
    hasOwnProperty(arg, 'family') &&
    typeof arg.family == 'string' &&
    hasOwnProperty(arg, 'port') &&
    typeof arg.port == 'number'
  );
};
