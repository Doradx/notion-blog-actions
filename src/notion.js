/*
 * @Author: Dorad, ddxi@qq.com
 * @Date: 2023-04-12 18:38:51 +02:00
 * @LastEditors: Dorad, ddxi@qq.com
 * @LastEditTime: 2023-09-04 10:35:40 +08:00
 * @FilePath: \src\notion.js
 * @Description: 
 * 
 * Copyright (c) 2023 by Dorad (ddxi@qq.com), All Rights Reserved.
 */
const { Client } = require("@notionhq/client");
const { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } = require("fs");
const { NotionToMarkdown } = require("notion-to-md");
const { parse } = require("twemoji");
const { getBlockChildren } = require("notion-to-md/build/utils/notion");
const YAML = require("yaml");
const path = require("path");
const { PicGo } = require("picgo");
const { migrateNotionImageFromURL } = require("./migrateNotionImage")
// const Migrater = require("./migrate");
const { format } = require("prettier");
const moment = require('moment-timezone');
const t = require('./customTransformer');

let config = {
  notion_secret: "",
  database_id: "",
  migrate_image: true,
  picBed: { uploader: "tcyun", current: "tcyun", tcyun: {}, aliyun: {} },
  status: {
    name: "",
    unpublish: "",
    published: "",
  },
  output_dir: {
    page: "",
    post: "",
    clean_unpublished_post: true,
  },
  timezone: "Asia/Shanghai",
  pic_compress: false,
  last_sync_datetime: 0,
  metas_keeped: [],
};

let notion = new Client({ auth: config.notion_secret });
let n2m = new NotionToMarkdown({ notionClient: notion });
let picgo = new PicGo();

function init(cfg) {
  config = cfg;
  notion = new Client({
    auth: config.notion_secret,
    config: {
      separateChildPage: true, // default: false
    }
  });

  if (!config?.pic_base_url && config.picBed?.uploader) {
    const bed = config.picBed[config.picBed?.uploader]
    if (bed?.customUrl && bed?.path) {
      config.pic_base_url = new URL(bed.path, bed.customUrl).href;
    }
  }

  let picgo_config = {
    "picBed": config.picBed,
    "pic-base-url": config?.pic_base_url || null
  }

  picgo_config["compress"] = config.pic_compress ? true : false;

  picgo.setConfig(picgo_config);
  picgo.setConfig({
    'picBed.transformer': 'base64'
  });
  picgo.setConfig({
    'settings.logLevel': ['success', 'error', 'warn']
  })

  // passing notion client to the option
  n2m = new NotionToMarkdown({ notionClient: notion });
  n2m.setCustomTransformer("callout", callout(n2m));
  n2m.setCustomTransformer("bookmark", t.bookmark);
  n2m.setCustomTransformer("video", t.video);
  n2m.setCustomTransformer("embed", t.embed);
  n2m.setCustomTransformer("link_preview", t.link_preview);
  n2m.setCustomTransformer("pdf", t.pdf);
  n2m.setCustomTransformer("audio", t.audio);
  n2m.setCustomTransformer("image", t.image);
}

async function sync() {
  // 获取已发布的文章
  let pages = await getPages(config.database_id);
  /**
   * 需要处理的逻辑:
   * 1. 对于已发布的文章，如果本地文件存在，且存在abbrlink，则更新notion中的abbrlink
   * 2. 对于本地存在的文章，如果notion中不是已发布状态，根据设置删除本地文件
   */
  // get all the output markdown filename list of the pages, and remove the file not exists in the pages under the output directory
  // query the filename list from the output directory
  let notionPagePropList = await Promise.all(pages.map(async (page) => {
    var properties = await getPropertiesDict(page);
    switch (properties?.ptype?.toLocaleLowerCase() || "") {
      case "page":
        if (!properties?.filename && !properties?.slug) {
          console.error(`Page ${properties.title} has no filename, the page id will be used as the filename.`);
          properties.filename = properties.id;
        }
        properties.filePath = path.join(config.output_dir.page, (properties?.filename || properties?.slug).trim(), 'index.md');
        properties.filename = "index.md";
        break;
      case "post":
      default:
        var filename = (properties?.filename || properties?.slug || properties?.title || properties.id).trim() + '.md'
        // get the filename and directory of the post, if the filename includes /, then it will be treated as a subdirectory
        properties.filePath = path.join(config.output_dir.post, filename);
        if (filename.includes("/")) filename = filename.split("/").pop();
        properties.filename = filename;
    }
    properties.output_dir = path.dirname(properties.filePath);
    return properties;
  }));
  console.debug(`${notionPagePropList.length} pages found in notion.`);
  // make the output directory if it is not exists
  if (!existsSync(config.output_dir.post)) {
    mkdirSync(config.output_dir.post, { recursive: true });
  }
  if (!existsSync(config.output_dir.page)) {
    mkdirSync(config.output_dir.page, { recursive: true });
  }
  /**
   * 1. 删除本地存在，但是Notion中不是已发布状态的文章
   * 2. 更新notion中已发布的文章的abbrlink
   *  */
  // load page properties from the markdown file
  const localPostFileList = readdirSync(config.output_dir.post);
  var deletedPostList = [];
  for (let i = 0; i < localPostFileList.length; i++) {
    const localFilename = localPostFileList[i];
    if (!localFilename.endsWith(".md")) {
      continue;
    }
    var localProp = loadPropertiesAndContentFromMarkdownFile(path.join(config.output_dir.post, localFilename));
    if (!localProp) {
      continue;
    }
    var page = pages.find((page) => {
      return page.id == localProp.id
    });
    var notionProp = notionPagePropList.find((prop)=>{
      return prop.id == localProp.id
    }) || null;
    // const filename = path.parse(localFilename).name;
    if (config.output_dir?.clean_unpublished_post && (!page || !notionProp || localFilename !== notionProp?.filename)){
      console.debug(`Page is not exists, delete the local file: ${localFilename}`);
      unlinkSync(path.join(config.output_dir.post, localFilename));
      deletedPostList.push(localFilename);
      continue;
    }
    // if the page is exists, update the abbrlink of the page if it is empty and the local file has the abbrlink
    // handle the metas_keeped, to update it
    if (config.metas_keeped && config.metas_keeped.length > 0) {
      let keysToUpdate = [];
      for (let i = 0; i < config.metas_keeped.length; i++) {
        const key = config.metas_keeped[i];
        if (localProp[key] && page.properties.hasOwnProperty(key) && !notionProp[key]) {
          page.properties[key].rich_text.push({
            "type": "text",
            "text": {
              "content": localProp[key],
              "link": null
            },
            "plain_text": localProp[key],
            "href": null
          });
          keysToUpdate.push(key);
        }
      }
      await updatePageProperties(page, keysToUpdate);
    }
  }

  /**
   * 处理需要更新的文章
   */
  if (config?.last_sync_datetime && config.last_sync_datetime !== null) {
    if (!moment(config?.last_sync_datetime).isValid()) {
      console.error(`The last_sync_datetime ${config.last_sync_datetime} isn't valid.`);
    }
    console.info(`Only sync the pages on or after ${config.last_sync_datetime}`);
    notionPagePropList = notionPagePropList.filter((prop) => prop[config.status.name] == config.status.published && moment(prop.last_edited_time) > moment(config.last_sync_datetime));
  }
  // deal with notionPagePropList
  if (notionPagePropList.length == 0) {
    console.info("No page to deal with.");
    return {
      queried: notionPagePropList.length,
      handled: 0,
      deleted: deletedPostList.length
    };
  }
  // 同步处理文章, 提高速度
  const results = await Promise.all(notionPagePropList.map(async (prop) => {
    let page = pages.find((page) => page.id == prop.id);
    console.debug(`Handle page: ${prop.id}, ${prop.title}`);
    /**
     * 只处理已发布的文章
     */
    // skip the page if it is not exists or published
    if (!page || prop[config.status.name] !== config.status.published) {
      console.info(`Page is not exists or published, skip: ${prop.id}, ${prop.title}`);
      return false;
    }
    /**
     * 对于已发布的文章，如果本地文件存在，且存在abbrlink，则更新notion中的abbrlink
     */
    // check if the local file exists
    if (!existsSync(prop.filePath)) {
      // the local file is not exists
      console.info(`File ${prop.filePath} is not exists, it's a new page.`);
    }
    // check the output directory, if the file is not exists, create it
    if (!existsSync(prop.output_dir)) {
      mkdirSync(prop.output_dir, { recursive: true });
    }
    // update the page status to published
    if (prop[config.status.name] == config.status.unpublish) {
      page.properties[config.status.name].select = { name: config.status.published };
    }
    // get the latest properties of the page
    const newPageProp = await getPropertiesDict(page);
    await page2Markdown(page, prop.filePath, newPageProp);
    console.info(`Page conversion successfully: ${prop.id}, ${prop.title}`);
    return true;
  }));
  return {
    queried: notionPagePropList.length,
    handled: results.filter((r) => r).length,
    deleted: deletedPostList.length
  };
}

/**
 * featch page from notion, and convert it to local markdown file
 * @param {*} page 
 * @param {*} filePath 
 * @param {*} properties 
 */

async function page2Markdown(page, filePath, properties) {
  const mdblocks = await n2m.pageToMarkdown(page.id);
  // 转换为markdown
  let md = n2m.toMarkdownString(mdblocks).parent;
  // 将图床上传和URL替换放到这里，避免后续对于MD文件的二次处理.
  if (config.migrate_image) {
    // 处理内容图片
    // find all image url inside markdown.
    const imgItems = md.match(/!\[.*\]\(([^)]+\.(?:jpg|jpeg|png|gif|bmp|svg|webp).*?)\)/g);
    if (!imgItems || imgItems.length == 0) {
      console.debug(`No image url found in the markdown file: ${filePath}`);
    } else {
      // 对于所有的图片url，进行并行处理
      const newImageItems = await Promise.all(imgItems.map(async (item) => {
        const mdImageReg = /!\[([^[\]]*)]\(([^)]+)\)/;
        if (!mdImageReg.test(item)) return [item, item];
        const match = mdImageReg.exec(item);
        const newPicUrl = await migrateNotionImageFromURL(picgo, match[2]);
        if (newPicUrl) {
          return [item, `![${match[1]}](${newPicUrl})`]
        }
        return [item, item];
      }));
      // 替换所有的图片url
      newImageItems.forEach((item) => {
        md = md.replace(item[0], item[1]);
      });
    }
    // 处理封面图
    // check if the page has image url in fm
    if (properties.cover && properties.cover.startsWith("https://")) {
      const newPicUrl = await migrateNotionImageFromURL(picgo, properties.cover);
      if (newPicUrl) {
        properties.cover = newPicUrl;
      }
    }
  }
  // remove created_time and last_edited_time from properties
  if (config?.metas_excluded && config.metas_excluded.length){
    // delete the key within metas_excluded for properties
    for(const key of config.metas_excluded){
      if(key && key in properties) {
        delete properties[key];
      }
    }
  }
  delete properties.created_time;
  delete properties.last_edited_time;
  let fm = YAML.stringify(properties, { doubleQuotedAsJSON: true });
  md = format(`---\n${fm}---\n\n${md}`, { parser: "markdown" });
  writeFileSync(filePath, md);
}

/**
 * 
 * @param {*} database_id 
 * @param {*} updated_after 
 * @returns 
 */
async function getPages(database_id) {
  let filter = {}
  filter = {
    property: config.status.name,
    select: {
      equals: config.status.published,
    },
  }
  // console.debug('Page filter:', filter);
  let resp = await notion.databases.query({
    database_id: database_id,
    filter: filter,
    sorts: [
      {
        timestamp: 'last_edited_time',
        direction: 'ascending'
      }
    ]
  });

  let pages = resp.results;
  while (resp.has_more) {
    resp = await notion.databases.query({
      database_id: database_id,
      filter: filter,
      sorts: [
        {
          timestamp: 'last_edited_time',
          direction: 'ascending'
        }
      ],
      start_cursor: resp.next_cursor
    });
    pages = pages.concat(resp.results);
  }

  return pages;
}

/**
 * update the page status to published, and update the abbrlink if exists
 * @param {*} page 
 */
async function updatePageProperties(page, keys = []) {
  // only update the status property
  // console.debug('Page full properties updated:', page.properties);
  if (keys.length == 0) return;
  let props_updated = {};
  // update status and abbrlink if exists
  keys.forEach(key => {
    if (page.properties[key]) {
      props_updated[key] = page.properties[key];
    }
  });
  console.debug(`Page ${page.id} properties updated keys:`, props_updated);
  await notion.pages.update({
    page_id: page.id,
    properties: props_updated,
  });
}

/**
 * load properties from the markdown file
 * @param {*} filepath 
 * @returns 
 */

function loadPropertiesAndContentFromMarkdownFile(filepath) {
  // load properties from the markdown file
  // check if the file already exists
  if (!existsSync(filepath)) {
    console.debug('File does not exist:', filepath);
    return null;
  }
  const content = readFileSync(filepath, 'utf8');
  // math the front matter
  const fm = content.match(/---\n([\s\S]*?)\n---/);
  // parse the front matter
  if (!fm) return null;
  try {
    let properties = YAML.parse(fm[1]);
    properties.filename = path.parse(filepath).name;
    return properties;
  } catch (e) {
    console.debug('Parse yaml error:', e);
    return null;
  }
}

/**
 * 生成元数据
 * @param {*} page
 * @returns {Object}
 */
async function getPropertiesDict(page) {
  if(!page) return {};
  let data = {};
  for (const key in page.properties) {
    const value = getPropVal(page.properties[key]);
    if (value == undefined || value == "") continue;
    data[key] = value;
  }
  // cover image
  if (page.cover) {
    if (page.cover.type === "external") {
      data['cover'] = page.cover.external.url;
    } else if (page.cover.type === "file") {
      data['cover'] = page.cover.file.url;
    }
  }
  // id, created, updated time
  data['id'] = page.id;
  data['created_time'] = page.created_time;
  data['last_edited_time'] = page.last_edited_time;
  return data;
}

/**
 *
 * @param {ListBlockChildrenResponseResult} block
 */
function callout(n2m) {
  return async (block) => {
    let callout_str = block.callout.text.map((a) => a.plain_text).join("");
    if (!block.has_children) {
      return callout2md(callout_str, block.callout.icon);
    }

    const callout_children_object = await getBlockChildren(
      n2m.notionClient,
      block.id,
      100
    );
    // parse children blocks to md object
    const callout_children = await n2m.blocksToMarkdown(
      callout_children_object
    );

    callout_str +=
      "\n" + callout_children.map((child) => child.parent).join("\n\n");

    return callout2md(callout_str.trim(), block.callout.icon);
  };
}

function callout2md(str, icon) {
  return `<aside>\n${icon2md(icon)}${str}\n</aside>`.trim();
}

function icon2md(icon) {
  switch (icon.type) {
    case "emoji":
      return parse(icon.emoji);
    case "external":
      return `<img src="${icon.external.url}" width="25px" />\n`;
  }
  return "";
}

function getPropVal(data) {
  let val = data[data.type];
  if (!val) return undefined;
  switch (data.type) {
    case "multi_select":
      return val.map((a) => a.name);
    case "select":
      return val.name;
    case "date":
      var mt = moment(val.start);
      if (!mt.isValid()) return val.start;
      return config?.timezone ? mt.tz(config.timezone).format('YYYY-MM-DD HH:mm:ss') : mt.format();
    case "rich_text":
    case "title":
      return val.map((a) => a.plain_text).join("");
    case "text":
      return data.plain_text;
    case "files":
      if (val.length < 1) return "";
      return val[0][val[0].type].url;
    case "created_time":
    case "last_edited_time":
      var mt = moment(val);
      if (!mt.isValid()) return val;
      return config?.timezone ? mt.tz(config.timezone).format('YYYY-MM-DD HH:mm:ss') : mt.format();
    default:
      return "";
  }
}

module.exports = {
  sync,
  init,
};
