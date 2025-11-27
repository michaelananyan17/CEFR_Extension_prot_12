// Content script for text rewriting and summarization
let originalTexts = new Map();
let isRewritten = false;
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 10;
const OPENAI_MODEL = 'gpt-3.5-turbo'; // Use a standard, fast model

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'rewritePage') {
        rewritePageContent(request.apiKey, request.targetLevel)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
    
    if (request.action === 'summarizePage') {
        summarizePageContent(request.apiKey, request.targetLevel)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
    
    if (request.action === 'resetPage') {
        resetPageContent();
        sendResponse({ success: true });
    }
    
    if (request.action === 'updateProgress') {
        sendResponse({ success: true });
    }
});

// ========== REWRITE PAGE FUNCTIONALITY ==========

// Main function to rewrite page content
async function rewritePageContent(apiKey, targetLevel) {
    try {
        if (!isRewritten) {
            storeOriginalTexts();
        }
        
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 10 });
        
        await rewriteTextElementsParallel(targetLevel, apiKey);
        
        isRewritten = true;
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 100 });
        
        return { success: true, elementsRewritten: originalTexts.size };
        
    } catch (error) {
        console.error('Content rewriting error:', error);
        return { success: false, error: error.message };
    }
}

// Parallel processing with concurrency control
async function rewriteTextElementsParallel(targetLevel, apiKey) {
    const items = Array.from(originalTexts.entries());
    const totalElements = items.length;
    let processedElements = 0;
    
    const chunkSize = MAX_CONCURRENT_REQUESTS;
    const chunks = [];
    
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }
    
    for (const chunk of chunks) {
        const promises = chunk.map(async ([index, item]) => {
            const originalText = item.originalText;
            
            if (originalText.trim().length > 10) {
                try {
                    const isTitle = item.element.tagName.match(/^H[1-6]$/i);
                    const rewrittenText = await fetchRewrittenText(originalText, targetLevel, apiKey, isTitle);
                    
                    // Update DOM using the fixed function
                    replaceElementTextSimple(item.element, rewrittenText);
                    
                } catch (error) {
                    console.error(`Error rewriting element ${index}:`, error);
                }
            }
            
            processedElements++;
            const progress = 10 + Math.floor((processedElements / totalElements) * 80);
            chrome.runtime.sendMessage({ action: 'progressUpdate', progress: progress });
        });
        
        await Promise.allSettled(promises);
        
        if (chunks.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

// Store original text content
function storeOriginalTexts() {
    originalTexts.clear();
    
    const textElements = document.querySelectorAll(`p, h1, h2, h3, h4, h5, h6,
        article p, article h1, article h2, article h3,
        main p, main h1, main h2, main h3
    `);
    
    let index = 0;
    
    textElements.forEach((element) => {
        if (shouldProcessElementStrict(element) &&
            element.textContent && 
            element.textContent.trim().length > 25 && 
            isVisible(element) &&
            !isInNav(element) &&
            !isInteractive(element) &&
            !isRandomTextBlock(element)) {
            
            const originalText = element.textContent;
            
            originalTexts.set(index, {
                element: element,
                originalText: originalText,
                originalHTML: element.innerHTML,
                tagName: element.tagName.toLowerCase()
            });
            index++;
        }
    });
}

// Fetch rewritten text from the OpenAI API (Reverted and Fixed)
async function fetchRewrittenText(originalText, targetLevel, apiKey, isTitle = false) {
    const cleanText = originalText.trim().replace(/\s+/g, ' ').substring(0, 4000); // Max tokens
    const temperature = getEnhancedTemperatureForLevel(targetLevel);
    const frequencyPenalty = getFrequencyPenaltyForLevel(targetLevel);
    
    const prompt = isTitle ? getTitlePromptForLevel(cleanText, targetLevel) : getTextPromptForLevel(cleanText, targetLevel);

    const messages = [
        {
            role: "system",
            content: "You are an expert content simplifier and rewriter. Your task is to rewrite the provided text to match a specific English fluency level (CEFR scale), while maintaining the core meaning and tone. Keep the output concise and directly corresponding to the input length. Do not add conversational framing or markdown."
        },
        { role: "user", content: prompt }
    ];

    const apiUrl = `https://api.openai.com/v1/chat/completions`;
    
    const payload = {
        model: OPENAI_MODEL,
        messages: messages,
        temperature: temperature,
        frequency_penalty: frequencyPenalty, // Use corrected penalty
        max_tokens: 4096 - 1000, // Allocate tokens for response
    };

    let response;
    for (let i = 0; i < 3; i++) {
        try {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}` // Using the API key in the header
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) break;

            if (response.status === 429) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
                continue;
            } else {
                throw new Error(`API error: ${response.statusText}`);
            }
        } catch (e) {
            if (i === 2) throw e;
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        }
    }

    if (!response || !response.ok) {
        throw new Error('Failed to fetch rewritten text after multiple retries.');
    }
    
    const result = await response.json();
    const rewrittenText = result.choices?.[0]?.message?.content;
    
    if (rewrittenText) {
        return rewrittenText.trim().replace(/^["']|["']$/g, '');
    }
    
    return originalText; // Return original on failure
}

// ========== SUMMARIZE PAGE FUNCTIONALITY ==========

// Main function to summarize page content
async function summarizePageContent(apiKey, targetLevel) {
    try {
        const mainContent = extractMainContent();
        
        if (!mainContent || mainContent.trim().length < 100) {
            throw new Error('Not enough content found to summarize');
        }
        
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 25 });
        
        const summary = await createSummary(mainContent, targetLevel, apiKey);
        
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 75 });
        
        // Download summary as text file
        downloadSummaryAsText(summary, targetLevel);
        
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 100 });
        
        return { success: true, summaryLength: summary.length };
        
    } catch (error) {
        console.error('Content summarization error:', error);
        return { success: false, error: error.message };
    }
}

// Create summary using the OpenAI API (Reverted)
async function createSummary(content, targetLevel, apiKey) {
    const cleanContent = cleanTextContent(content).substring(0, 14000); // Max tokens
    
    const systemPrompt = `You create comprehensive summaries at specific CEFR English levels while preserving key information. The summary must be a single, concise paragraph.`;
    
    const prompt = `Summarize the following text to CEFR level ${targetLevel} English. Preserve key facts, names, dates, and important information.
    
    Text: "${cleanContent}"
    
    Summary:`;

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
    ];

    const apiUrl = `https://api.openai.com/v1/chat/completions`;

    const payload = {
        model: OPENAI_MODEL,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000,
    };
    
    let response;
    for (let i = 0; i < 3; i++) {
        try {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}` 
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) break;

            if (response.status === 429) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
                continue;
            } else {
                throw new Error(`API error: ${response.statusText}`);
            }
        } catch (e) {
            if (i === 2) throw e;
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        }
    }

    if (!response || !response.ok) {
        throw new Error('Failed to fetch summary text after multiple retries.');
    }
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || 'Summary failed.';
}

// Download summary as text file
function downloadSummaryAsText(summary, targetLevel) {
    const blob = new Blob([summary], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `summary-${targetLevel}-${timestamp}.txt`;
    
    chrome.runtime.sendMessage({
        action: 'download',
        url: url,
        filename: filename
    });
}

// ========== FIXED UTILITY FUNCTIONS ==========

/**
 * FIXED: Logic corrected. Positive numbers prevent repetition (for diversity/C1/C2).
 * Lower/Neutral numbers allow natural repetition (for simplicity/A1/A2).
 */
function getFrequencyPenaltyForLevel(targetLevel) {
    const penaltyMap = {
        'A1': 0.0,  // Neutral: Allows natural repetition (essential for simple, clear English)
        'A2': 0.1,  // Very Low: Allows most repetition but prevents looping
        'B1': 0.2,  // Low: Begins to encourage some vocabulary variation
        'B2': 0.3,  // Moderate: Encourages standard professional variety
        'C1': 0.4,  // High: Actively discourages repeating the same words
        'C2': 0.5   // Very High: Forces the model to use diverse, sophisticated synonyms
    };
    return penaltyMap[targetLevel] || 0.0;
}

/**
 * FIXED: Reworked function to replace element text while preserving links.
 * Fixes the "mashed link text" issue (e.g., "IS-3pike nose") by:
 * 1. Finding and cloning all existing links.
 * 2. Clearing the element's content.
 * 3. Inserting the new, rewritten text as a single text node.
 * 4. Appending the original link elements (a tags) back into the element, separated by spaces.
 */
function replaceElementTextSimple(element, newText) {
    // 1. Find and clone all links in the original element
    const linksToPreserve = Array.from(element.querySelectorAll('a')).map(link => link.cloneNode(true));
    
    // 2. Clear the element's content entirely
    element.innerHTML = '';
    
    const trimmedNewText = newText.trim();
    
    // 3. Insert the new text content
    const newTextNode = document.createTextNode(trimmedNewText);
    element.appendChild(newTextNode);
        
    // 4. Append all the original links after the new text, separated by a space
    linksToPreserve.forEach(link => {
        // Add a space or separator before the link
        element.appendChild(document.createTextNode(' '));
        element.appendChild(link);
    });
    
    // Minimal visual feedback
    element.style.transition = 'opacity 0.2s ease';
    element.style.opacity = '0.9';
    setTimeout(() => {
        element.style.opacity = '1';
    }, 100);
}

// Helper functions for content processing (unchanged)
function getEnhancedTemperatureForLevel(targetLevel) {
    const temperatureMap = {
        'A1': 0.2,
        'A2': 0.3,
        'B1': 0.5,
        'B2': 0.7,
        'C1': 0.85,
        'C2': 0.95
    };
    return temperatureMap[targetLevel] || 0.5;
}

function getTitlePromptForLevel(originalText, targetLevel) {
    const levelInstructions = {
        'A1': `Rewrite this title to CEFR level A1 English. Use only the most basic vocabulary. Make it extremely simple and clear. Maximum 8 words.`,
        'A2': `Rewrite this title to CEFR level A2 English. Use basic everyday vocabulary. Keep sentences short. Maximum 10 words.`,
        'B1': `Rewrite this title to CEFR level B1 English. Use clear, practical language. Maximum 12 words.`,
        'B2': `Rewrite this title to CEFR level B2 English. Use more varied vocabulary and complex sentence structures.`,
        'C1': `Rewrite this title to CEFR level C1 English. Use sophisticated vocabulary and complex grammatical structures.`,
        'C2': `Rewrite this title to CEFR level C2 English. Use highly sophisticated, near-native level vocabulary. Make it eloquent and precise.`
    };
    const instruction = levelInstructions[targetLevel] || levelInstructions['B1'];
    return `${instruction}\n\nOriginal: "${originalText}"\nRewritten:`;
}

function getTextPromptForLevel(originalText, targetLevel) {
    const levelInstructions = {
        'A1': `Rewrite this text to CEFR level A1 English. Use ONLY the most basic vocabulary. Use extremely short, simple sentences. Only use present tense. Avoid any complex grammar. Preserve names, dates, numbers exactly.`,
        'A2': `Rewrite this text to CEFR level A2 English. Use basic everyday vocabulary. Use short, clear sentences. Use simple grammar structures. Avoid complex clauses.`,
        'B1': `Rewrite this text to CEFR level B1 English. Use clear, practical language. You can use some compound sentences and basic connecting words. Show control of main grammatical structures.`,
        'B2': `Rewrite this text to CEFR level B2 English. Use more varied vocabulary and complex sentence structures. Show good range of grammatical structures.`,
        'C1': `Rewrite this text to CEFR level C1 English. Use sophisticated vocabulary and a wide range of complex grammatical structures. Use idiomatic expressions and stylistic variations appropriately.`,
        'C2': `Rewrite this text to CEFR level C2 English. Use highly sophisticated, near-native level vocabulary with precision. Employ complex rhetorical devices, varied sentence structures, and subtle stylistic choices.`
    };
    const instruction = levelInstructions[targetLevel] || levelInstructions['B1'];
    return `Rewrite the following text for a ${targetLevel} level. ${instruction}\n\nText: "${originalText}"\nRewritten:`;
}

function shouldProcessElementStrict(element) {
    const tagName = element.tagName.toLowerCase();
    const className = element.className.toLowerCase();
    const text = element.textContent.trim();
    
    if (text.length < 30 && !tagName.match(/^h[1-6]$/)) return false;
    
    const excludeClasses = ['meta', 'time', 'date', 'author', 'byline', 'caption', 'label', 'btn', 'button', 'icon'];
    for (const excludeClass of excludeClasses) {
        if (className.includes(excludeClass)) return false;
    }
    
    if (tagName.match(/^h[1-6]$/) || tagName === 'p') {
        return isInMainContent(element);
    }
    return true;
}

function isInMainContent(element) {
    const mainContentSelectors = [
        'main', 'article', '[role="main"]', '.content', '.main-content',
        '.post-content', '.article-content', '.story-content', '.entry-content'
    ];
    
    for (const selector of mainContentSelectors) {
        if (element.closest(selector)) return true;
    }
    
    const nonContentContainers = ['header', 'footer', 'nav', 'aside', '.header', '.footer', '.nav', '.sidebar'];
    for (const container of nonContentContainers) {
        if (element.closest(container)) return false;
    }
    return true;
}

function isRandomTextBlock(element) {
    const text = element.textContent.trim();
    
    if (text.length < 40 && !element.tagName.match(/^H[1-6]$/i)) return true;
    
    const metaPatterns = [
        /\d{1,2}\/\d{1,2}\/\d{4}/, 
        /^(by|posted|published|updated):?/i, 
        /^\d+\s*(comments|shares|likes)$/i,
        /^[A-Z][a-z]+day,\s+[A-Z][a-z]+\s+\d{1,2}/i 
    ];
    
    for (const pattern of metaPatterns) {
        if (pattern.test(text)) return true;
    }
    return false;
}

function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && 
           style.visibility !== 'hidden' && 
           style.opacity !== '0' &&
           element.offsetWidth > 0 &&
           element.offsetHeight > 0;
}

function isInNav(element) {
    return element.closest('nav, .nav, .navigation, .menu, header, .header, footer, .footer, aside, .sidebar');
}

function isInteractive(element) {
    return element.tagName === 'BUTTON' || 
           element.tagName === 'A' ||
           element.getAttribute('role') === 'button' ||
           element.onclick != null;
}

function resetPageContent() {
    if (!isRewritten) return;
    
    originalTexts.forEach(item => {
        item.element.innerHTML = item.originalHTML;
    });
    
    isRewritten = false;
}

function extractMainContent() {
    const contentSelectors = [
        'article', 'main', '[role="main"]', '.content', '.main-content',
        '.article-content', '.post-content', '.story-content', '.entry-content'
    ];
    
    for (const selector of contentSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim().length > 200) {
            return element.textContent;
        }
    }
    
    const textElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
    const content = Array.from(textElements)
        .filter(el => isVisible(el) && !isInNav(el) && el.textContent.trim().length > 50)
        .map(el => el.textContent.trim())
        .join('\n\n');
    
    return content || document.body.textContent;
}

function cleanTextContent(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .trim();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'download') {
        chrome.downloads.download({
            url: request.url,
            filename: request.filename,
            saveAs: false
        });
        sendResponse({ success: true });
    }
});
