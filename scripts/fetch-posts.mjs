import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFilePath = fileURLToPath(import.meta.url);
const scriptsFolder = path.dirname(thisFilePath);
const projectFolder = path.resolve(scriptsFolder, "..");
const accountsFilePath = path.join(projectFolder, "accounts.json");
const outputFilePath = path.join(projectFolder, "site", "posts.json");

const apifyToken = process.env.APIFY_TOKEN;

if (!apifyToken) {
  console.error("APIFY_TOKEN is missing. Add it as a secret first.");
  process.exit(1);
}

const accountsText = fs.readFileSync(accountsFilePath, "utf8");
const config = JSON.parse(accountsText);

const hoursToKeep = config.settings.hoursToKeep;
const maxPostsPerAccount = config.settings.maxPostsPerAccount;
const millisecondsToKeep = hoursToKeep * 60 * 60 * 1000;
const nowTime = Date.now();
const oldestAllowedTime = nowTime - millisecondsToKeep;
const fiveMinutes = 5 * 60 * 1000;

function wait(milliseconds) {
  return new Promise(function (resolve) {
    setTimeout(resolve, milliseconds);
  });
}

async function callApifyOnce(actorId, input) {
  const requestUrl =
    "https://api.apify.com/v2/acts/" + actorId + "/run-sync-get-dataset-items";

  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apifyToken
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(310000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error("Apify answered " + response.status + " " + errorText.slice(0, 300));
  }

  const items = await response.json();

  if (!Array.isArray(items)) {
    throw new Error("Apify did not return a list of items");
  }

  return items;
}

async function callApify(actorId, input) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt = attempt + 1) {
    try {
      const items = await callApifyOnce(actorId, input);
      return items;
    } catch (error) {
      lastError = error;
      console.error("Attempt " + attempt + " failed: " + error.message);

      if (attempt < 2) {
        await wait(15000);
      }
    }
  }

  throw lastError;
}

async function fetchTextOnce(requestUrl) {
  const response = await fetch(requestUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; social-feed)"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error("YouTube answered " + response.status);
  }

  const text = await response.text();
  return text;
}

async function fetchTextWithRetry(requestUrl) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt = attempt + 1) {
    try {
      const text = await fetchTextOnce(requestUrl);
      return text;
    } catch (error) {
      lastError = error;
      console.error("Attempt " + attempt + " failed: " + error.message);

      if (attempt < 2) {
        await wait(10000);
      }
    }
  }

  throw lastError;
}

function decodeXmlText(text) {
  let result = String(text);
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");
  result = result.replace(/&quot;/g, "\"");
  result = result.replace(/&#39;/g, "'");
  result = result.replace(/&apos;/g, "'");
  result = result.replace(/&amp;/g, "&");
  return result;
}

function readTagValue(text, tagName) {
  const pattern = new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)</" + tagName + ">");
  const match = pattern.exec(text);

  if (!match) {
    return "";
  }

  const decodedText = decodeXmlText(match[1]);
  return decodedText.trim();
}

function readLinkHref(entryText) {
  const firstPattern = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/;
  const firstMatch = firstPattern.exec(entryText);

  if (firstMatch) {
    return decodeXmlText(firstMatch[1]);
  }

  const secondPattern = /<link[^>]*href="([^"]+)"[^>]*rel="alternate"/;
  const secondMatch = secondPattern.exec(entryText);

  if (secondMatch) {
    return decodeXmlText(secondMatch[1]);
  }

  return "";
}

function readThumbnailUrl(entryText) {
  const pattern = /<media:thumbnail[^>]*url="([^"]+)"/;
  const match = pattern.exec(entryText);

  if (!match) {
    return "";
  }

  return decodeXmlText(match[1]);
}

function parseYoutubeFeed(feedText) {
  const videos = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match = entryPattern.exec(feedText);

  while (match !== null) {
    const entryText = match[1];
    const videoId = readTagValue(entryText, "yt:videoId");
    const title = readTagValue(entryText, "title");
    const published = readTagValue(entryText, "published");

    let videoUrl = readLinkHref(entryText);

    if (videoUrl === "" && videoId !== "") {
      videoUrl = "https://www.youtube.com/watch?v=" + videoId;
    }

    let thumbnailUrl = readThumbnailUrl(entryText);

    if (thumbnailUrl === "" && videoId !== "") {
      thumbnailUrl = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
    }

    videos.push({
      videoId: videoId,
      title: title,
      published: published,
      url: videoUrl,
      thumbnail: thumbnailUrl
    });

    match = entryPattern.exec(feedText);
  }

  return videos;
}

async function fetchYoutubeItems(channels) {
  const allVideos = [];

  for (let channelIndex = 0; channelIndex < channels.length; channelIndex = channelIndex + 1) {
    const channel = channels[channelIndex];
    const feedUrl = "https://www.youtube.com/feeds/videos.xml?channel_id=" + channel.channelId;
    const feedText = await fetchTextWithRetry(feedUrl);
    const videos = parseYoutubeFeed(feedText);

    for (let videoIndex = 0; videoIndex < videos.length; videoIndex = videoIndex + 1) {
      const video = videos[videoIndex];
      video.accountName = channel.name;
      allVideos.push(video);
    }
  }

  return allVideos;
}

function readTimeFromValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number") {
    if (value < 100000000000) {
      return value * 1000;
    }
    return value;
  }

  if (typeof value === "string") {
    const parsedTime = Date.parse(value);

    if (Number.isNaN(parsedTime)) {
      return null;
    }

    return parsedTime;
  }

  return null;
}

function readLinkedinTime(item) {
  if (!item.postedAt) {
    return null;
  }

  const timeFromTimestamp = readTimeFromValue(item.postedAt.timestamp);

  if (timeFromTimestamp !== null) {
    return timeFromTimestamp;
  }

  const timeFromDate = readTimeFromValue(item.postedAt.date);
  return timeFromDate;
}

function readLastPart(urlText) {
  if (!urlText) {
    return "";
  }

  const withoutQuery = String(urlText).split("?")[0];
  const withoutEndSlash = withoutQuery.replace(/\/+$/, "");
  const parts = withoutEndSlash.split("/");
  const lastPart = parts[parts.length - 1];
  return lastPart.toLowerCase();
}

function cutText(text, maxLength) {
  if (!text) {
    return "";
  }

  const cleanText = String(text).trim();

  if (cleanText.length <= maxLength) {
    return cleanText;
  }

  return cleanText.slice(0, maxLength);
}

function readLinkedinImage(item) {
  if (Array.isArray(item.postImages) && item.postImages.length > 0) {
    const firstImage = item.postImages[0];

    if (typeof firstImage === "string") {
      return firstImage;
    }

    if (firstImage && typeof firstImage.url === "string") {
      return firstImage.url;
    }
  }

  if (item.document && Array.isArray(item.document.coverPages)) {
    if (item.document.coverPages.length > 0) {
      const firstCover = item.document.coverPages[0];

      if (firstCover && Array.isArray(firstCover.imageUrls)) {
        if (firstCover.imageUrls.length > 0) {
          return firstCover.imageUrls[0];
        }
      }
    }
  }

  return "";
}

function normalizeInstagramItem(item, accounts) {
  if (!item || !item.url) {
    return null;
  }

  const postTime = readTimeFromValue(item.timestamp);

  if (postTime === null) {
    return null;
  }

  let ownerName = "";

  if (item.ownerUsername) {
    ownerName = String(item.ownerUsername).toLowerCase();
  }

  let displayName = ownerName;

  for (let index = 0; index < accounts.length; index = index + 1) {
    const account = accounts[index];

    if (account.username.toLowerCase() === ownerName) {
      displayName = account.name;
    }
  }

  let imageUrl = "";

  if (item.displayUrl) {
    imageUrl = item.displayUrl;
  }

  return {
    id: item.url,
    platform: "instagram",
    account: displayName,
    url: item.url,
    text: cutText(item.caption, 400),
    image: imageUrl,
    postedAt: new Date(postTime).toISOString()
  };
}

function normalizeLinkedinItem(item, accounts) {
  if (!item || !item.linkedinUrl) {
    return null;
  }

  const postTime = readLinkedinTime(item);

  if (postTime === null) {
    return null;
  }

  const authorKeys = [];
  let authorName = "";

  if (item.author) {
    if (item.author.publicIdentifier) {
      authorKeys.push(String(item.author.publicIdentifier).toLowerCase());
    }

    if (item.author.universalName) {
      authorKeys.push(String(item.author.universalName).toLowerCase());
    }

    authorKeys.push(readLastPart(item.author.linkedinUrl));

    if (item.author.name) {
      authorName = item.author.name;
    }
  }

  let displayName = authorName;
  let foundAccount = false;

  for (let accountIndex = 0; accountIndex < accounts.length; accountIndex = accountIndex + 1) {
    const account = accounts[accountIndex];
    const accountSlug = readLastPart(account.url);

    for (let keyIndex = 0; keyIndex < authorKeys.length; keyIndex = keyIndex + 1) {
      if (authorKeys[keyIndex] === accountSlug) {
        displayName = account.name;
        foundAccount = true;
      }
    }
  }

  if (!foundAccount && accounts.length === 1) {
    displayName = accounts[0].name;
  }

  return {
    id: item.linkedinUrl,
    platform: "linkedin",
    account: displayName,
    url: item.linkedinUrl,
    text: cutText(item.content, 400),
    image: readLinkedinImage(item),
    postedAt: new Date(postTime).toISOString()
  };
}

function normalizeYoutubeItem(item, accounts) {
  if (!item || !item.url) {
    return null;
  }

  const postTime = readTimeFromValue(item.published);

  if (postTime === null) {
    return null;
  }

  return {
    id: item.url,
    platform: "youtube",
    account: item.accountName,
    url: item.url,
    text: cutText(item.title, 400),
    image: item.thumbnail,
    postedAt: new Date(postTime).toISOString()
  };
}

async function runJob(job) {
  let items = [];

  if (job.fetchItems) {
    items = await job.fetchItems();
  } else {
    items = await callApify(job.actorId, job.input);
  }

  console.log(job.name + ": " + items.length + " items received");

  const posts = [];

  for (let index = 0; index < items.length; index = index + 1) {
    const post = job.normalizeItem(items[index], job.accounts);

    if (post !== null) {
      posts.push(post);
    }
  }

  console.log(job.name + ": " + posts.length + " usable posts");
  return posts;
}

const jobs = [];

if (config.instagram.length > 0) {
  const usernames = [];

  for (let index = 0; index < config.instagram.length; index = index + 1) {
    usernames.push(config.instagram[index].username);
  }

  jobs.push({
    name: "Instagram",
    actorId: config.actors.instagram,
    accounts: config.instagram,
    normalizeItem: normalizeInstagramItem,
    input: {
      username: usernames,
      resultsLimit: maxPostsPerAccount,
      skipPinnedPosts: true,
      onlyPostsNewerThan: "2 days"
    }
  });
}

if (config.linkedinProfiles.length > 0) {
  const profileUrls = [];

  for (let index = 0; index < config.linkedinProfiles.length; index = index + 1) {
    profileUrls.push(config.linkedinProfiles[index].url);
  }

  jobs.push({
    name: "LinkedIn profiles",
    actorId: config.actors.linkedinProfiles,
    accounts: config.linkedinProfiles,
    normalizeItem: normalizeLinkedinItem,
    input: {
      targetUrls: profileUrls,
      maxPosts: maxPostsPerAccount,
      postedLimit: "24h",
      includeReposts: false,
      includeQuotePosts: true
    }
  });
}

if (config.linkedinPages.length > 0) {
  const pageUrls = [];

  for (let index = 0; index < config.linkedinPages.length; index = index + 1) {
    pageUrls.push(config.linkedinPages[index].url);
  }

  jobs.push({
    name: "LinkedIn pages",
    actorId: config.actors.linkedinPages,
    accounts: config.linkedinPages,
    normalizeItem: normalizeLinkedinItem,
    input: {
      targetUrls: pageUrls,
      maxPosts: maxPostsPerAccount,
      postedLimit: "24h",
      includeReposts: false,
      includeQuotePosts: true
    }
  });
}

const validYoutubeChannels = [];

if (config.youtube) {
  for (let index = 0; index < config.youtube.length; index = index + 1) {
    const channel = config.youtube[index];
    const channelIdText = String(channel.channelId);
    const looksValid = /^UC[A-Za-z0-9_-]{22}$/.test(channelIdText);

    if (looksValid) {
      validYoutubeChannels.push(channel);
    } else {
      console.log("::warning::YouTube channel " + channel.name + " skipped. Put the real channelId in accounts.json");
    }
  }
}

if (validYoutubeChannels.length > 0) {
  jobs.push({
    name: "YouTube",
    accounts: validYoutubeChannels,
    normalizeItem: normalizeYoutubeItem,
    fetchItems: function () {
      return fetchYoutubeItems(validYoutubeChannels);
    }
  });
}

const allPosts = [];
let successfulJobs = 0;
let failedJobs = 0;

for (let jobIndex = 0; jobIndex < jobs.length; jobIndex = jobIndex + 1) {
  const job = jobs[jobIndex];

  try {
    const jobPosts = await runJob(job);

    for (let postIndex = 0; postIndex < jobPosts.length; postIndex = postIndex + 1) {
      allPosts.push(jobPosts[postIndex]);
    }

    successfulJobs = successfulJobs + 1;
  } catch (error) {
    failedJobs = failedJobs + 1;
    console.error(job.name + " failed: " + error.message);
    console.log("::warning::" + job.name + " could not be fetched in this run");
  }
}

if (successfulJobs === 0) {
  console.error("All fetches failed. The old site is kept as it is.");
  process.exit(1);
}

const freshPosts = [];
const seenUrls = {};

for (let index = 0; index < allPosts.length; index = index + 1) {
  const post = allPosts[index];
  const postTime = Date.parse(post.postedAt);

  if (postTime < oldestAllowedTime) {
    continue;
  }

  if (postTime > nowTime + fiveMinutes) {
    continue;
  }

  if (seenUrls[post.url]) {
    continue;
  }

  seenUrls[post.url] = true;
  freshPosts.push(post);
}

freshPosts.sort(function (firstPost, secondPost) {
  return Date.parse(secondPost.postedAt) - Date.parse(firstPost.postedAt);
});

const output = {
  updatedAt: new Date(nowTime).toISOString(),
  hoursToKeep: hoursToKeep,
  posts: freshPosts
};

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, JSON.stringify(output, null, 2));

console.log("Saved " + freshPosts.length + " posts from the last " + hoursToKeep + " hours");
console.log("Jobs ok: " + successfulJobs + ", jobs failed: " + failedJobs);