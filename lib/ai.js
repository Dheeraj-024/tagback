const { clip, rnd, sha } = require("./utils");

// Supported categories in TagBack Community
const VALID_CATEGORIES = [
  "RIDE_SHARING",
  "HELP_REQUEST",
  "LOST_AND_FOUND",
  "DISCUSSION",
  "ANNOUNCEMENT",
  "RECOMMENDATION"
];

// Configuration
const AI_DAILY_CAP = +(process.env.AI_DAILY_CAP || 500);
const AI_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const aiUse = { day: "", n: 0 };
function checkBudget() {
  const d = new Date().toISOString().slice(0, 10);
  if (aiUse.day !== d) {
    aiUse.day = d;
    aiUse.n = 0;
  }
  return aiUse.n < AI_DAILY_CAP;
}

function getCache(key) {
  const entry = AI_CACHE.get(key);
  if (entry && Date.now() - entry.t < CACHE_TTL_MS) {
    return entry.v;
  }
  AI_CACHE.delete(key);
  return null;
}

function setCache(key, val) {
  if (AI_CACHE.size >= 500) {
    const oldestKey = AI_CACHE.keys().next().value;
    AI_CACHE.delete(oldestKey);
  }
  AI_CACHE.set(key, { v: val, t: Date.now() });
}

// Redact phone numbers and emails before sending to external LLM
function redactPII(text) {
  return String(text || "")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email removed]")
    .replace(/\+?\d[\d\s\-()]{7,}\d/g, "[number removed]");
}

/**
 * Universal LLM caller that supports Gemini, Anthropic, or OpenAI.
 * Returns null if no API key is provided or on failure, prompting heuristic fallback.
 */
async function callLLM(systemPrompt, userPrompt, maxTokens = 400) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;

  if (!geminiKey && !anthropicKey && !openAiKey) {
    return null;
  }

  if (!checkBudget()) {
    console.warn("[AI] Daily cap reached. Falling back to built-in heuristics.");
    return null;
  }

  aiUse.n++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);

  try {
    // 1. Google Gemini
    if (geminiKey) {
      const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
      const payload = {
        contents: [
          {
            role: "user",
            parts: [{ text: `${systemPrompt}\n\nTask:\n${userPrompt}` }]
          }
        ],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.2
        }
      };

      const resp = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        console.error("[AI Gemini] Error status:", resp.status);
        return null;
      }
      const data = await resp.json();
      return (
        data.candidates?.[0]?.content?.parts?.[0]?.text || null
      );
    }

    // 2. Anthropic Claude
    if (anthropicKey) {
      const url = process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
      const model = process.env.AI_MODEL || "claude-3-5-haiku-20241022";
      const resp = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });

      if (!resp.ok) {
        console.error("[AI Anthropic] Error status:", resp.status);
        return null;
      }
      const data = await resp.json();
      return (data.content || []).map(c => c.text || "").join("");
    }

    // 3. OpenAI
    if (openAiKey) {
      const url = "https://api.openai.com/v1/chat/completions";
      const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
      const resp = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openAiKey}`
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        })
      });

      if (!resp.ok) {
        console.error("[AI OpenAI] Error status:", resp.status);
        return null;
      }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || null;
    }
  } catch (err) {
    console.error("[AI Error]:", err.message || err.name);
    return null;
  } finally {
    clearTimeout(timer);
  }

  return null;
}

// Extract JSON object safely from LLM output
function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    return null;
  }
}

// Built-in Indian city list for deterministic heuristics
const POPULAR_CITIES = [
  "Delhi", "New Delhi", "Noida", "Gurgaon", "Gurugram", "Faridabad", "Ghaziabad",
  "Bengaluru", "Bangalore", "Mumbai", "Pune", "Hyderabad", "Chennai", "Kolkata",
  "Ahmedabad", "Jaipur", "Chandigarh", "Lucknow", "Indore", "Kochi", "Goa"
];

/**
 * 1. Smart Post Parsing & Community Recommendation:
 * Takes natural language text (e.g. "need a cab from CP to Airport tomorrow 6am ₹800")
 * and extracts structured fields plus the most suitable community.
 */
function recommendCommunity(cleanText, detectedCity, category, availableCommunities = []) {
  if (!availableCommunities || !availableCommunities.length) {
    return {
      recommendedCommunity: (detectedCity && detectedCity.toLowerCase() === "delhi") ? "cabs_delhi" : "cabs_city",
      recommendReason: "General community match",
      matchedCommunities: []
    };
  }

  const lower = cleanText.toLowerCase();
  const scored = availableCommunities.map(comm => {
    let score = 0;
    const reasons = [];
    const cname = (comm.name || "").toLowerCase();
    const ccity = (comm.city || "").toLowerCase();
    const cdesc = (comm.desc || comm.description || "").toLowerCase();

    // 1. Exact or detected City match
    if (detectedCity && ccity && (detectedCity.toLowerCase() === ccity || lower.includes(ccity))) {
      score += 45;
      reasons.push(comm.city);
    } else if (ccity && lower.includes(ccity)) {
      score += 40;
      reasons.push(comm.city);
    }

    // 2. Category & Intent match
    if (category === "RIDE_SHARING" || /cab|taxi|ride|lift|drop|carpool|airport|station|driver/i.test(lower)) {
      if (cname.includes("cab") || cname.includes("ride") || cdesc.includes("cab") || cdesc.includes("trip") || cdesc.includes("driver")) {
        score += 50;
        reasons.push("transit & cabs");
      }
    }

    if (/hotel|stay|room|pg|lodge|hostel|accommodation|guest/i.test(lower)) {
      if (cname.includes("hotel") || cname.includes("stay") || cdesc.includes("stay") || cdesc.includes("hotel") || cdesc.includes("host")) {
        score += 55;
        reasons.push("lodging & stays");
      }
    }

    if (category === "LOST_AND_FOUND" || /lost|found|missing|chabi|wallet|bag|laptop|phone|keys/i.test(lower)) {
      if (cname.includes("lost") || cname.includes("found") || cdesc.includes("lost") || cdesc.includes("found")) {
        score += 55;
        reasons.push("lost & found");
      }
    }

    if (category === "HELP_REQUEST" || /help|urgent|assist|repair|mechanic/i.test(lower)) {
      if (cname.includes("help") || cdesc.includes("help") || cname.includes("assist")) {
        score += 45;
        reasons.push("assistance");
      }
    }

    // Keyword overlap
    const words = lower.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3);
    for (const w of words) {
      if (cname.includes(w)) score += 15;
      if (cdesc.includes(w)) score += 10;
    }

    return {
      name: comm.name,
      city: comm.city || null,
      desc: comm.desc || comm.description || "",
      members: comm.members || 0,
      score,
      reason: reasons.length ? `Recommended for ${reasons.join(" · ")}` : "Recommended"
    };
  });

  scored.sort((a, b) => b.score - a.score || b.members - a.members);

  const top = scored[0];
  return {
    recommendedCommunity: top ? top.name : availableCommunities[0].name,
    recommendReason: top && top.score > 0 ? top.reason : "General community",
    matchedCommunities: scored
  };
}

async function parsePost(rawText, availableCommunities = []) {
  const text = clip(rawText, 500);
  if (!text) return null;

  const cacheKey = "parse:" + text.toLowerCase().trim() + ":" + (availableCommunities ? availableCommunities.length : 0);
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const cleanText = redactPII(text);

  const commSummary = availableCommunities && availableCommunities.length ?
    `\nAvailable communities to pick from:\n${availableCommunities.map(c => `- ${c.name} (City: ${c.city || "All"}, Desc: ${c.desc || c.description || ""})`).join("\n")}` : "";

  const systemPrompt = `You are a helpful assistant for a community assistance and ride-sharing platform called TagBack.
Given a user's natural language post draft, parse and extract structured fields.${commSummary}
Reply with ONLY ONE valid JSON object, no markdown, no other text:
{
  "category": "RIDE_SHARING" | "HELP_REQUEST" | "LOST_AND_FOUND" | "DISCUSSION" | "ANNOUNCEMENT" | "RECOMMENDATION",
  "postType": "NEED" | "OFFER",
  "title": "Concise, clear post title (max 70 chars)",
  "city": "City name if mentioned (e.g. Delhi, Bengaluru, Mumbai) or empty string",
  "from": "Origin location if ride or transit (or empty string)",
  "to": "Destination location if ride or transit (or empty string)",
  "location": "Specific pickup, drop, or area landmark (or empty string)",
  "budget": "Estimated budget or reward with currency symbol e.g. ₹800 or empty string",
  "targetTime": "Date and/or time mentioned e.g. 'Tomorrow 6:00 AM' or empty string",
  "body": "Clean description expanding on details (max 200 chars)",
  "recommendedCommunity": "Best matching community name from available list",
  "recommendReason": "Brief 1-sentence reason why this community fits best"
}`;

  const llmOut = await callLLM(systemPrompt, cleanText, 350);
  const parsed = extractJson(llmOut);

  if (parsed && parsed.title && parsed.category) {
    const cat = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : "DISCUSSION";
    const city = clip(parsed.city, 50) || "";
    const rec = recommendCommunity(cleanText, city, cat, availableCommunities);
    const result = {
      category: cat,
      postType: parsed.postType === "OFFER" ? "OFFER" : "NEED",
      title: clip(parsed.title, 80),
      city: city,
      from: clip(parsed.from, 60) || "",
      to: clip(parsed.to, 60) || "",
      location: clip(parsed.location || (parsed.from && parsed.to ? `${parsed.from} ➔ ${parsed.to}` : ""), 100),
      budget: clip(parsed.budget, 40) || "",
      targetTime: clip(parsed.targetTime, 50) || "",
      body: clip(parsed.body, 300) || cleanText,
      recommendedCommunity: (parsed.recommendedCommunity && availableCommunities.some(c => c.name === parsed.recommendedCommunity)) ? parsed.recommendedCommunity : rec.recommendedCommunity,
      recommendReason: clip(parsed.recommendReason, 120) || rec.recommendReason,
      matchedCommunities: rec.matchedCommunities,
      mode: "ai"
    };
    setCache(cacheKey, result);
    return result;
  }

  // --- High-precision heuristic fallback ---
  const lower = cleanText.toLowerCase();

  // Category & PostType detection
  let cat = "DISCUSSION";
  let postType = "NEED";
  if (/offer|available|leaving for|have seats|driving to|can take|giving/i.test(cleanText)) {
    postType = "OFFER";
  }

  if (/cab|taxi|ride|lift|drop|pool|carpool|auto|uber|ola|airport|station|highway/i.test(cleanText)) {
    cat = "RIDE_SHARING";
  } else if (/lost|found|missing|chabi|wallet|bag|laptop|phone|keys|dropped/i.test(cleanText)) {
    cat = "LOST_AND_FOUND";
  } else if (/help|urgent|need someone|assistance|mechanic|plumber|doctor|emergency|req/i.test(cleanText)) {
    cat = "HELP_REQUEST";
  } else if (/recommend|suggestion|best place|good restaurant|pg|flat|stay/i.test(cleanText)) {
    cat = "RECOMMENDATION";
  } else if (/announc|notice|attention|rules|update/i.test(cleanText)) {
    cat = "ANNOUNCEMENT";
  }

  // City extraction
  let detectedCity = "";
  for (const c of POPULAR_CITIES) {
    const regex = new RegExp(`\\b${c}\\b`, "i");
    if (regex.test(cleanText)) {
      detectedCity = c;
      break;
    }
  }

  // Budget / Price extraction: e.g. ₹800, Rs. 500, 400 rs, budget 1000
  let budget = "";
  const budgetMatch = cleanText.match(/(?:₹|rs\.?|inr)\s*(\d+[\d,]*)/i) || cleanText.match(/(\d+[\d,]*)\s*(?:rs|rupees|bucks|₹)/i);
  if (budgetMatch) {
    budget = "₹" + budgetMatch[1].replace(/,/g, "");
  }

  // Time extraction: e.g. tomorrow 6am, 9:30 pm, today evening
  let targetTime = "";
  const timeMatch = cleanText.match(/(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(?:morning|afternoon|evening|night|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}\s*(?:am|pm))/i);
  if (timeMatch && timeMatch[0].trim()) {
    targetTime = timeMatch[0].trim();
  }

  // From / To extraction for rides: e.g. "from CP to Airport"
  let from = "", to = "", loc = "";
  const fromToMatch = cleanText.match(/from\s+([^,]+?)\s+to\s+([^,]+?)(?:\s+(?:tomorrow|today|around|at|for|₹|rs|\d)|$)/i);
  if (fromToMatch) {
    from = fromToMatch[1].trim();
    to = fromToMatch[2].trim();
    loc = `${from} ➔ ${to}`;
  }

  // Title generation
  let title = cleanText.length > 70 ? cleanText.slice(0, 67) + "..." : cleanText;
  if (cat === "RIDE_SHARING" && loc) {
    title = `${postType === "NEED" ? "Need ride" : "Offering ride"}: ${loc}`;
  }

  const rec = recommendCommunity(cleanText, detectedCity, cat, availableCommunities);

  const result = {
    category: cat,
    postType,
    title,
    city: detectedCity,
    from,
    to,
    location: loc,
    budget,
    targetTime,
    body: cleanText,
    recommendedCommunity: rec.recommendedCommunity,
    recommendReason: rec.recommendReason,
    matchedCommunities: rec.matchedCommunities,
    mode: "heuristic"
  };
  setCache(cacheKey, result);
  return result;
}

/**
 * 2. Smart Content Moderation:
 * Checks for advance payment scams, off-platform wire transfers, harassment, or leaked numbers.
 */
async function moderateContent(title, body) {
  const combined = `${title || ""} ${body || ""}`.trim();
  if (!combined) {
    return { safe: true, risk: "low", flags: [], flagAction: "allow" };
  }

  const cacheKey = "mod:" + sha(combined);
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const clean = redactPII(combined);

  // Fast deterministic checks for obvious high-risk patterns
  const scamKeywords = [
    /send\s+(?:advance\s+)?(?:payment|money|cash|token|deposit)\s+(?:first|before|to)/i,
    /advance\s+(?:payment|money|fee|deposit|token)/i,
    /(?:google\s*pay|gpay|phonepe|paytm|upi)\s+(?:advance|qr|transfer\s+first)/i,
    /earn\s+\d+k\s+(?:daily|weekly|hourly)/i,
    /dm\s+on\s+(?:telegram|whatsapp)\s+for\s+(?:cash|payment|job|deal)/i,
    /crypto\s+investment\s+guaranteed/i
  ];

  const foundScams = scamKeywords.filter(r => r.test(combined));
  if (foundScams.length > 0) {
    const res = {
      safe: false,
      risk: "high",
      flags: ["advance_payment_scam_pattern"],
      reason: "Potential advance payment scam or off-platform payment solicitation detected.",
      flagAction: "block"
    };
    setCache(cacheKey, res);
    return res;
  }

  const systemPrompt = `You are an automated safety and moderation filter for a community platform.
Analyze the user content for:
1. Financial scams or advance-fee requests.
2. Harassment, threats, hate speech, or severe abuse.
3. Explicit solicitation or illegal goods.
Reply with ONLY ONE valid JSON object:
{
  "safe": true | false,
  "risk": "low" | "medium" | "high",
  "reason": "Brief explanation if unsafe or flagged, else ''",
  "flagAction": "allow" | "flag" | "block"
}`;

  const llmOut = await callLLM(systemPrompt, clean, 200);
  const parsed = extractJson(llmOut);

  if (parsed && typeof parsed.safe === "boolean") {
    const res = {
      safe: parsed.safe,
      risk: ["low", "medium", "high"].includes(parsed.risk) ? parsed.risk : "low",
      reason: clip(parsed.reason, 150) || "",
      flagAction: ["allow", "flag", "block"].includes(parsed.flagAction) ? parsed.flagAction : "allow",
      mode: "ai"
    };
    setCache(cacheKey, res);
    return res;
  }

  // Fallback heuristic: clean text passes
  const res = { safe: true, risk: "low", flags: [], flagAction: "allow", mode: "heuristic" };
  setCache(cacheKey, res);
  return res;
}

/**
 * 3. Finder Recovery Message Assistant:
 * Transforms rough finder notes into a reassuring, courteous message to the owner.
 */
async function assistFinderMessage(itemName, draftText, ownerName) {
  const item = itemName || "belongings";
  const owner = ownerName || "the owner";
  const draft = clip(draftText, 300) || "";

  const systemPrompt = `You help a good samaritan who found a lost item compose a reassuring, courteous message to the owner.
Never include personal phone numbers or email. Keep it under 200 characters.
Return ONLY ONE JSON object:
{
  "message": "Polite, helpful message to the owner"
}`;

  const userPrompt = `Item: ${item}\nOwner: ${owner}\nFinder's notes: ${draft || "Found safe"}`;
  const llmOut = await callLLM(systemPrompt, userPrompt, 150);
  const parsed = extractJson(llmOut);

  if (parsed && parsed.message) {
    return clip(parsed.message, 250);
  }

  // Heuristic fallback
  if (draft) {
    return `Hi ${owner}! I found your ${item}. ${draft}. It is kept safely with me — please let me know how you'd like to arrange pickup!`;
  }
  return `Hi ${owner}! I found your ${item} safe and sound. Please let me know how and where you'd like to collect it.`;
}

/**
 * 4. Private Deal Chat Reply Suggestions:
 * Suggests 2-3 quick, practical reply pills for ride sharing or help requests.
 */
async function suggestDealReplies(postContext, lastMessages = [], userRole = "author") {
  const postTitle = clip(postContext?.title || "", 100);
  const postType = postContext?.postType || "NEED";

  const systemPrompt = `You suggest 3 short, polite, practical replies (under 40 characters each) for a private coordination chat.
Reply with ONLY ONE valid JSON object:
{
  "suggestions": ["Reply 1", "Reply 2", "Reply 3"]
}`;

  const lastTxt = lastMessages.map(m => `${m.from || "user"}: ${m.text || m.body || ""}`).join("\n");
  const userPrompt = `Post: "${postTitle}" (${postType})\nChat history:\n${lastTxt || "(New conversation)"}`;

  const llmOut = await callLLM(systemPrompt, userPrompt, 200);
  const parsed = extractJson(llmOut);

  if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length) {
    return parsed.suggestions.slice(0, 3).map(s => clip(s, 50));
  }

  // Heuristic fallback based on post topic
  const lower = postTitle.toLowerCase();
  if (/ride|cab|taxi|drop|lift/i.test(lower)) {
    return [
      "What time works best for you?",
      "Where should we meet for pickup?",
      "Sounds good, I will see you there!"
    ];
  }
  if (/lost|found/i.test(lower)) {
    return [
      "Thank you so much for finding it!",
      "Where can I come to collect it?",
      "I'm available now if you're free."
    ];
  }
  return [
    "Sounds great, let's do this!",
    "Could you share a few more details?",
    "Thanks! Looking forward to it."
  ];
}

/**
 * 5. Thread Summarizer:
 * Summarizes long discussion threads into 2-3 key takeaways.
 */
async function summarizeThread(postTitle, comments = []) {
  if (!comments || !comments.length) {
    return "No comments in this thread yet.";
  }

  const commentTexts = comments
    .map(c => `- ${clip(c.body || c.text || "", 120)}`)
    .slice(0, 15)
    .join("\n");

  const systemPrompt = `You provide a concise 2-sentence summary of community discussion comments.
Highlight the consensus, best suggestions, or key takeaways. Return ONLY ONE JSON object:
{
  "summary": "2-sentence summary of the discussion"
}`;

  const userPrompt = `Topic: "${postTitle}"\nComments:\n${commentTexts}`;
  const llmOut = await callLLM(systemPrompt, userPrompt, 200);
  const parsed = extractJson(llmOut);

  if (parsed && parsed.summary) {
    return clip(parsed.summary, 300);
  }

  // Heuristic summary
  const total = comments.length;
  const topText = comments[0]?.body ? clip(comments[0].body, 90) : "";
  return `Community thread with ${total} response${total > 1 ? "s" : ""}. Key perspective: "${topText}..."`;
}

module.exports = {
  parsePost,
  moderateContent,
  assistFinderMessage,
  suggestDealReplies,
  summarizeThread
};
