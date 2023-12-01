/*
 * @Author: Dorad, ddxi@qq.com
 * @Date: 2023-09-03 14:22:38 +08:00
 * @LastEditors: Dorad, ddxi@qq.com
 * @LastEditTime: 2023-09-04 11:13:42 +08:00
 * @FilePath: \src\migrateNotionImage.js
 * @Description: 
 * 
 * Copyright (c) 2023 by Dorad (ddxi@qq.com), All Rights Reserved.
 */


const path = require("path");
const sizeOf = require("image-size");
const imagemin = require("imagemin");
const imageSize = require("image-size");
const imageminPngquant = require("imagemin-pngquant");
const imageminMozjpeg = require("imagemin-mozjpeg");
const imageminGifsicle = require("imagemin-gifsicle");
const imageminSvgo = require("imagemin-svgo");
const fs = require('fs');
const { count } = require("console");

async function migrateNotionImageFromURL(ctx, url) {
  // 检查图片是否为notion的图片
  const urlReg = /^https:\/\/.*?amazonaws\.com\/.+\.(?:jpg|jpeg|bmp|tif|tiff|svg|png|gif|webp)\?.+/;
  if (!urlReg.test(url)) {
    // console.log(`Image ${url} is not a notion image, skip`);
    return url;
  }
  // 检查URL对应的图片是否已经存在
  const base_url = ctx.getConfig('pic-base-url') || null;
  const uuidreg = /[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}/g;
  const uuid = url.match(uuidreg)?.pop();
  let ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  ext = ext == 'jpeg' ? 'jpg' : ext; // replace jpeg with jpg
  ext = ext == 'tiff' ? 'tif' : ext; // replace tiff with tif
  if (base_url) {
    const picUrl = new URL(`${uuid}.${ext}`, base_url).href;
    // get pic uuid from the url using regex
    if (await checkPicExist(ctx, picUrl)) {
      // console.log(`Image ${picUrl} already exists, skip`)
      return picUrl;
    }
  }
  // 不存在则上传图片
  try {
    // 从URL获取图片信息
    let imageItem = await handlePicFromURL(ctx, url);
    // 检查是否需要压缩图片
    if (ctx.getConfig('compress') && ext !== 'svg') {
      // 压缩图片
      imageItem = await compressPic(imageItem);
    }
    imageItem.fileName = `${uuid}.${ext}`;

    // 如果有存储到本地需求，直接存储
    
    const filePath = `source/image/${imageItem.fileName}`; // ` 'source/image/'+imageItem.fileName 
    fs.watchFile(filePath,imageItem.buffer,(err)=>{
      if (err) {
        console.error(err);
        return;
      }
      console.log('文件已保存');
    })
    return "image/" + imageItem.fileName;

    // 上传图片
    const result = await ctx.upload([imageItem]);
    if (result && result[0] && result[0].imgUrl) {
      ctx.log.info(`Upload image ${result[0].imgUrl} success`);
      return result[0].imgUrl;
    }
    ctx.log.error(`Upload image ${url} fail`);
    return undefined;
  } catch (e) {
    ctx.log.error(`Upload image ${url} fail: ${e}`);
    return undefined;
  }
}

// 检查图片是否存在
async function checkPicExist(ctx, picUrl) {
  try {
    const res = await ctx.request({
      method: "HEAD",
      url: picUrl,
      resolveWithFullResponse: true
    })
    return res.status === 200;
  } catch (e) {
    // ctx.log.error('check pic exist error: ', e)
    return false;
  }
}

// 从URL获取图片信息
async function handlePicFromURL(ctx, url) {
  try {
    if (url.includes("data:image/svg+xml")) {
      let data = url.replace("data:image/svg+xml;utf8,", "");
      return {
        buffer: Buffer.from(decodeURIComponent(data), "utf-8"),
        fileName: `${new Date().getTime()}.svg`,
        extname: ".svg",
        origin: url,
      };
    }
    const buffer = await ctx.request({
      url,
      encoding: null,
      responseType: "arraybuffer",
    })
    const fileName = path.basename(url).split('?')[0].split('#')[0]
    const imgSize = getImageSize(buffer)
    return {
      buffer,
      fileName,
      width: imgSize.width,
      height: imgSize.height,
      extname: `.${imgSize.type || 'png'}`,
      origin: url
    }
  } catch (e) {
    this.ctx.log.error(`handle pic from url ${url} fail: ${JSON.stringify(e)}`)
    return undefined
  }
}

// 图片压缩
function compressPic(item) {
  return imagemin.buffer(item.buffer, {
    plugins: [
      imageminPngquant(),
      imageminMozjpeg(),
      imageminGifsicle(),
      imageminSvgo()
    ],
  }).then((newBuffer) => {
    const { width, height } = imageSize(newBuffer);
    // update the buffer
    item.buffer = newBuffer;
    item.width = width;
    item.height = height;
    console.log(`Compress image ${item.fileName} success`);
    return item;
  });
}

// 获取图片大小
function getImageSize(buffer) {
  try {
    const size = sizeOf(buffer)
    return {
      real: true,
      width: size.width,
      height: size.height,
      type: size.type
    }
  } catch (e) {
    // fallback to default size
    return {
      real: false,
      width: 200,
      height: 200,
      type: '.png'
    }
  }
}


module.exports = {
  migrateNotionImageFromURL
}