const postListElement = document.getElementById("post-list");
const emptyMessageElement = document.getElementById("empty-message");
const updatedTextElement = document.getElementById("updated-text");
const tabButtons = document.querySelectorAll(".tab");

const HOURS_TO_SHOW = 24;
const MILLISECONDS_IN_MINUTE = 60 * 1000;
const MILLISECONDS_IN_HOUR = 60 * MILLISECONDS_IN_MINUTE;
const RELOAD_EVERY_MINUTES = 10;
const REDRAW_EVERY_MINUTES = 1;
const MAX_TEXT_LENGTH = 220;

let allPosts = [];
let lastUpdatedTime = null;
let selectedFilter = "all";
let loadFailed = false;

function makeAgoText(pastTime) {
  const nowTime = Date.now();
  const differenceInMinutes = Math.floor((nowTime - pastTime) / MILLISECONDS_IN_MINUTE);

  if (differenceInMinutes < 1) {
    return "just now";
  }

  if (differenceInMinutes < 60) {
    return differenceInMinutes + " min ago";
  }

  const differenceInHours = Math.floor(differenceInMinutes / 60);

  if (differenceInHours === 1) {
    return "1 hour ago";
  }

  return differenceInHours + " hours ago";
}

function getFreshPosts() {
  const nowTime = Date.now();
  const oldestAllowedTime = nowTime - HOURS_TO_SHOW * MILLISECONDS_IN_HOUR;
  const freshPosts = [];

  for (let index = 0; index < allPosts.length; index = index + 1) {
    const post = allPosts[index];
    const postTime = Date.parse(post.postedAt);

    if (Number.isNaN(postTime)) {
      continue;
    }

    if (postTime < oldestAllowedTime) {
      continue;
    }

    if (typeof post.url !== "string") {
      continue;
    }

    if (post.url.indexOf("https://") !== 0) {
      continue;
    }

    freshPosts.push(post);
  }

  return freshPosts;
}

function updateTabLabels(freshPosts) {
  let instagramCount = 0;
  let linkedinCount = 0;

  for (let index = 0; index < freshPosts.length; index = index + 1) {
    if (freshPosts[index].platform === "instagram") {
      instagramCount = instagramCount + 1;
    }

    if (freshPosts[index].platform === "linkedin") {
      linkedinCount = linkedinCount + 1;
    }
  }

  for (let index = 0; index < tabButtons.length; index = index + 1) {
    const button = tabButtons[index];
    const filterName = button.getAttribute("data-filter");

    if (filterName === "all") {
      button.textContent = "All (" + freshPosts.length + ")";
    }

    if (filterName === "instagram") {
      button.textContent = "Instagram (" + instagramCount + ")";
    }

    if (filterName === "linkedin") {
      button.textContent = "LinkedIn (" + linkedinCount + ")";
    }

    if (filterName === selectedFilter) {
      button.classList.add("active");
    } else {
      button.classList.remove("active");
    }
  }
}

function makeShortText(text) {
  if (typeof text !== "string") {
    return "";
  }

  if (text.length <= MAX_TEXT_LENGTH) {
    return text;
  }

  return text.slice(0, MAX_TEXT_LENGTH).trim() + "...";
}

function makePlatformName(platform) {
  if (platform === "instagram") {
    return "Instagram";
  }

  if (platform === "linkedin") {
    return "LinkedIn";
  }

  return platform;
}

function createPostCard(post) {
  const card = document.createElement("a");
  card.className = "card";
  card.href = post.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";

  const topRow = document.createElement("div");
  topRow.className = "card-top";

  const badge = document.createElement("span");
  badge.className = "badge " + post.platform;
  badge.textContent = makePlatformName(post.platform);
  topRow.appendChild(badge);

  const accountName = document.createElement("span");
  accountName.className = "account";
  accountName.textContent = post.account;
  topRow.appendChild(accountName);

  const timeText = document.createElement("span");
  timeText.className = "time";
  timeText.textContent = makeAgoText(Date.parse(post.postedAt));
  topRow.appendChild(timeText);

  card.appendChild(topRow);

  if (typeof post.image === "string" && post.image.indexOf("https://") === 0) {
    const image = document.createElement("img");
    image.className = "card-image";
    image.src = post.image;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";

    image.addEventListener("error", function () {
      image.remove();
    });

    card.appendChild(image);
  }

  const shortText = makeShortText(post.text);

  if (shortText !== "") {
    const textElement = document.createElement("p");
    textElement.className = "card-text";
    textElement.textContent = shortText;
    card.appendChild(textElement);
  }

  const openLink = document.createElement("span");
  openLink.className = "open-link";
  openLink.textContent = "Open post →";
  card.appendChild(openLink);

  return card;
}

function updateTopText() {
  if (loadFailed && lastUpdatedTime === null) {
    updatedTextElement.textContent = "Could not load posts. Please refresh the page.";
    return;
  }

  if (lastUpdatedTime === null) {
    updatedTextElement.textContent = "Waiting for the first update.";
    return;
  }

  updatedTextElement.textContent =
    "Last checked " + makeAgoText(lastUpdatedTime) + ". Posts stay for " + HOURS_TO_SHOW + " hours.";
}

function renderPosts() {
  const freshPosts = getFreshPosts();
  updateTabLabels(freshPosts);
  updateTopText();

  const visiblePosts = [];

  for (let index = 0; index < freshPosts.length; index = index + 1) {
    const post = freshPosts[index];

    if (selectedFilter === "all") {
      visiblePosts.push(post);
    } else if (post.platform === selectedFilter) {
      visiblePosts.push(post);
    }
  }

  while (postListElement.firstChild) {
    postListElement.removeChild(postListElement.firstChild);
  }

  for (let index = 0; index < visiblePosts.length; index = index + 1) {
    const card = createPostCard(visiblePosts[index]);
    postListElement.appendChild(card);
  }

  if (visiblePosts.length === 0) {
    emptyMessageElement.classList.remove("hidden");
  } else {
    emptyMessageElement.classList.add("hidden");
  }
}

async function loadPosts() {
  try {
    const response = await fetch("posts.json?t=" + Date.now(), { cache: "no-store" });

    if (!response.ok) {
      throw new Error("posts.json answered " + response.status);
    }

    const data = await response.json();

    if (Array.isArray(data.posts)) {
      allPosts = data.posts;
    } else {
      allPosts = [];
    }

    if (data.updatedAt) {
      lastUpdatedTime = Date.parse(data.updatedAt);
    }

    loadFailed = false;
  } catch (error) {
    loadFailed = true;
    console.error(error);
  }

  renderPosts();
}

for (let index = 0; index < tabButtons.length; index = index + 1) {
  tabButtons[index].addEventListener("click", function (event) {
    selectedFilter = event.currentTarget.getAttribute("data-filter");
    renderPosts();
  });
}

loadPosts();
setInterval(loadPosts, RELOAD_EVERY_MINUTES * MILLISECONDS_IN_MINUTE);
setInterval(renderPosts, REDRAW_EVERY_MINUTES * MILLISECONDS_IN_MINUTE);
