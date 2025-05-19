/**
 * Copyright (c) Bucher + Suter.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  PapersaurusPluginOptions,
  TocInfo,
} from './types';
import { Props, LoadedPlugin } from '@docusaurus/types';
import { LoadedContent, LoadedVersion, DocMetadata } from "@docusaurus/plugin-content-docs"
import puppeteer = require('puppeteer');
import toc = require('html-toc');
const pdfMerge = require('easy-pdf-merge');
const pdfParse = require('pdf-parse');
const join = require('path').join;
import express = require('express');
import { AddressInfo } from 'net';
import * as fs from 'fs-extra';
const GithubSlugger = require('github-slugger');
const cheerio = require('cheerio');

let slugger = new GithubSlugger();

const pluginLogPrefix = '[papersaurus] ';

export async function generatePdfFiles(
  outDir: string,
  pluginOptions: PapersaurusPluginOptions,
  { siteConfig, plugins }: Props) {

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

  const linkToFile: { [key: string]: { label: string, file: string, type: 'root' | 'section' | 'chapter' }[] } = {};

  // Loop through all found versions
  for (const versionInfo of (docPlugin.content as LoadedContent).loadedVersions) {
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
      let versionPath = getVersionPath(versionInfo, siteConfig);
      const versionPdfPath = [pdfPath, versionPath, folderName].filter(str => str != "").join("/");
      const versionBuildDir = join(pdfBuildDir, versionPath, folderName);
      fs.ensureDirSync(versionBuildDir);

      console.log(`${pluginLogPrefix}Start processing sidebar named '${sidebarName}' in version '${versionInfo.label}'`);

      let sidebar = versionInfo.sidebars[sidebarName];
      if (sidebar) {
        let projectName = siteConfig.projectName;
        if (!projectName) {
          console.log(`${pluginLogPrefix}Docusaurus projectName not set, using placeholder...`);
          projectName = 'Unnamed project';
        }
        // Create a fake category with root of sidebar
        const rootCategory: any = {
          type: 'category',
          label: projectName,
          unversionedId: projectName,
          items: sidebar,
          collapsed: true,
          collapsible: true
        };

        // Browse through all documents of this sidebar
        pickHtmlArticlesRecursive(rootCategory, [], versionInfo, `${siteAddress}docs/`, docusaurusBuildDir, siteConfig);

        let productVersion = "";

        if ((docPlugin.content as LoadedContent).loadedVersions.length === 1){
          productVersion = pluginOptions.productVersion;
        }

        // Create all PDF files for this sidebar
        await createPdfFilesRecursive(
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

        // Save url to filename mappings
        saveUrlToFileMappingsRecursive(rootCategory.items, linkToFile, [{
          label: rootCategory.label,
          file: rootCategory.pdfFilename,
          type: 'root'
        }])
      }
      else {
        console.log(`${pluginLogPrefix}Sidebar '${sidebarName}' doesn't exist in version '${versionInfo.label}', continue without it...`);
      }

    }

  }

  fs.writeFileSync(join(docusaurusBuildDir, 'pdfs.json'), JSON.stringify(linkToFile));

  browser.close();
  httpServer.close();

  console.log(`${pluginLogPrefix}generatePdfFiles finished!`);
}

function stripTrailingSlash (str: string) {
  return str.endsWith('/') ?
    str.slice(0, -1) : str;
};

function saveUrlToFileMappingsRecursive(
  sideBarItems: any[],
  output: { [key: string]: { label: string, file: string, type: 'root' | 'section' | 'chapter' }[] },
  parents: { label: string, file: string, type: 'root' | 'section' | 'chapter' }[] = []) {

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
  siteConfig: any) {
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
        readHtmlForItem(sideBarItem, parentTitles, rootDocUrl, path, version, siteConfig);
      }
      else {
        console.log("a", sideBarItem.label)
        sideBarItem.unversionedId = sideBarItem.label || "untitled";
      }
      const newParentTitles = [...parentTitles];
      newParentTitles.push(sideBarItem.label);
      for (const categorySubItem of sideBarItem.items) {
        pickHtmlArticlesRecursive(categorySubItem, newParentTitles, version, rootDocUrl, htmlDir, siteConfig);
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
      readHtmlForItem(sideBarItem, parentTitles, rootDocUrl, path, version, siteConfig);
      break;
    }
    default:
      break;
  }
}

async function createPdfFilesRecursive(sideBarItem: any,
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
): Promise<any[]> {

  let articles: any[] = [];
  switch (sideBarItem.type) {
    case 'category': {
      if (sideBarItem.permalink) {
        articles.push(sideBarItem);
      }
      const newParentTitles = [...parentTitles];
      newParentTitles.push(sideBarItem.label);
      const newParentIds = [...parentIds];
      newParentIds.push(sideBarItem.unversionedId);
      for (const categorySubItem of sideBarItem.items) {
        const subDocs = await createPdfFilesRecursive(categorySubItem,
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
        articles.push(...subDocs);
      }
      break;
    }
    case 'doc': {
      articles.push(sideBarItem);
      break;
    }
    default:
      break;
  }

  let pdfFilename = pluginOptions.getPdfFileName(siteConfig, pluginOptions, sideBarItem.label, sideBarItem.unversionedId, parentTitles, parentIds, version.versionName, version.path);
  pdfFilename = slugger.slug(pdfFilename);

  let documentTitle = sideBarItem.label || '';

  if (parentTitles.length > 1) {
    documentTitle = parentTitles.slice(1).join(' / ') + ' / ' + documentTitle;
  }

  if (productTitle) {
    documentTitle = productTitle + ' / ' + documentTitle;
  }

  if (articles.length > 0) {
    await createPdfFromArticles(documentTitle,
      productVersion || version.label,
      pdfFilename,
      articles,
      pluginOptions,
      siteConfig,
      buildDir,
      browser,
      siteAddress);

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
  siteConfig: any) {

  let htmlFilePath = htmlDir;
  htmlFilePath = join(htmlFilePath, 'index.html');

  let stylePath = '';
  let scriptPath = '';
  let html = '';

  console.log(`${pluginLogPrefix}Reading file ${htmlFilePath}`);

  let htmlFileContent: string = fs.readFileSync(htmlFilePath, { encoding: 'utf8' });

  const origin = (new URL(rootDocUrl)).origin;
  stylePath = getStylesheetPathFromHTML(htmlFileContent, origin);

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
    if (parentTitles.length > 1) {
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
  documentTitle: string,
  documentVersion: string,
  pdfName: string,
  articleList: any[],
  pluginOptions: PapersaurusPluginOptions,
  siteConfig: any,
  buildDir: string,
  browser: puppeteer.Browser,
  siteAddress: string
): Promise<void> {

  console.log(`${pluginLogPrefix}Creating PDF ${buildDir}\\${pdfName}.pdf...`);

  const titlePdfFile = join(buildDir, `${pdfName}.title.pdf`);
  const contentRawPdfFile = join(buildDir, `${pdfName}.content.raw.pdf`);
  const contentHtmlFile = join(buildDir, `${pdfName}.content.html`);
  const contentPdfFile = join(buildDir, `${pdfName}.content.pdf`);
  const finalPdfFile = join(buildDir, `${pdfName}.pdf`);

  const coverPage = await browser.newPage();
  await coverPage.setContent(
    pluginOptions.getPdfCoverPage(siteConfig, pluginOptions, documentTitle, documentVersion),
    {
      timeout: pluginOptions.puppeteerTimeout
    });
  await coverPage.pdf({
    format: 'a4',
    path: titlePdfFile,
    headerTemplate: pluginOptions.coverPageHeader,
    footerTemplate: pluginOptions.coverPageFooter,
    displayHeaderFooter: true,
    printBackground: true,
    margin: pluginOptions.coverMargins,
    timeout: pluginOptions.puppeteerTimeout
  });
  await coverPage.close();

  const page = await browser.newPage();

  let stylePath = articleList[0].stylePath;
  let scriptPath = articleList[0].scriptPath;

  let fullHtml = '';
  for (const article of articleList) {
    if (articleList.length > 1 && pluginOptions.ignoreDocs.includes(article.unversionedId || '-IdIsEmpty-')) {
      // Don't add ignored articles to PDF's with multiple articles (section pdf's, complete document pdf)
      continue;
    }
    fullHtml += article.articleHtml || '';
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

  let htmlToc = fullHtml.substring(14, fullHtml.indexOf('</div>'));

  htmlToc = htmlToc.replace(/class="nav sidenav"/g, 'class="toc-headings"');
  htmlToc = htmlToc.replace(/class="nav"/g, 'class="toc-headings"');
  htmlToc = htmlToc.replace(/[\r\n]+/g, '');

  const htmlArticles = fullHtml.substring(fullHtml.indexOf('</div>') + 6);
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

  let htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="generator" content="Papersaurus">
      ${htmlStyles}
      ${htmlScripts}
    </head>
    <body>
      ${htmlToc}${htmlArticles}
    </body>
  </html>`;

  await generateContentPdf(contentRawPdfFile);

  const dataBuffer = fs.readFileSync(contentRawPdfFile);
  const parsedData = await pdfParse(dataBuffer);

  htmlContent = getPageWithFixedToc(pluginOptions.footerParser, tocLinksInfos, parsedData.text, htmlContent);

  await generateContentPdf(contentPdfFile);

  htmlContent = await page.content();
  fs.writeFileSync(contentHtmlFile, htmlContent);

  await page.close();

  await mergeMultiplePDF([titlePdfFile, contentPdfFile], finalPdfFile);

  fs.unlinkSync(titlePdfFile);
  fs.unlinkSync(contentRawPdfFile);
  fs.unlinkSync(contentPdfFile);
  if (!pluginOptions.keepDebugHtmls) {
    fs.unlinkSync(contentHtmlFile);
  }

  async function generateContentPdf(targetFile: string) {
    await page.goto(siteAddress);
    await page.setContent(htmlContent, {
      timeout: pluginOptions.puppeteerTimeout
    });
    await page.pdf({
      path: targetFile,
      format: 'a4',
      headerTemplate: pluginOptions.getPdfPageHeader(siteConfig, pluginOptions, documentTitle, documentVersion),
      footerTemplate: pluginOptions.getPdfPageFooter(siteConfig, pluginOptions, documentTitle, documentVersion),
      displayHeaderFooter: true,
      printBackground: true,
      scale: 1,
      margin: pluginOptions.margins,
      timeout: pluginOptions.puppeteerTimeout
    });

  }
}

const mergeMultiplePDF = (pdfFiles: string[], name: string) => {
  return new Promise((resolve, reject) => {
    pdfMerge(pdfFiles, name, function (err: any) {

      if (err) {
        console.log(err);
        reject(err)
      }

      resolve('')
    });
  });
};

const escapeHeaderRegex = (header: string) => {
  return header
    // escape all regex reserved characters
    .replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')
    // replace white-spaces to allow line breaks
    .replace(/\s/g, '(\\s|\\s\\n)');
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

const getPageWithFixedToc = (footerRegEx: RegExp, tocList: TocInfo[], pdfContent: string, htmlContent: string) => {

  const pdfPages = pdfContent.split(footerRegEx);
  if (!pdfPages.length) {
    return htmlContent;
  }

  const footerRegexString = footerRegEx.source;
  const headerFooterRegexString = `.*\\n${footerRegexString}`;
  const headerFooterRegex = new RegExp(headerFooterRegexString, footerRegEx.flags);

  let pdfContentTOC = pdfContent;
  pdfContentTOC = pdfContentTOC.replace(headerFooterRegex, '');
  pdfContentTOC = pdfContentTOC.replace(/_/g, '');
  pdfContentTOC = pdfContentTOC.split('\n').map(line => line.trimEnd()).join('\n');

  let linesArray = pdfContentTOC.split('\n');
  linesArray = linesArray.filter(line => line.trim() !== '');
  let linesTOC = linesArray.slice(1, 1 + tocList.length);


  let pageIndex = 0;
  let lastPageIndex = pageIndex;
  for (let i1 = 0; i1 < tocList.length; i1++) {
    const elementTOC = linesTOC[i1];
    let found = false;
    for (; pageIndex < pdfPages.length; pageIndex++) {
      let page = pdfPages[pageIndex];
      found = false;
      for (let i = 0; i < pdfHeaderRegex.length; ++i) {
        if (pdfHeaderRegex[i](decodeHtml(elementTOC)).test(page)) {
          htmlContent = htmlContent.replace(
              '<span class="pageNumber">_</span>',
              `<span class="pageNumber">${pageIndex + 1}</span>`
          );
          lastPageIndex = pageIndex;
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    if (!found){
      htmlContent = htmlContent.replace(
          '<span class="pageNumber">_</span>',
          `<span class="pageNumber">${lastPageIndex + 1}</span>`
      );
      pageIndex = lastPageIndex
    }
  }

  return htmlContent;
}

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
