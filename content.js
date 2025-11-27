// Content script for text rewriting and summarization
let originalTexts = new Map();
let isRewritten = false;
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 10;

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
        // Store original texts if not already stored
        if (!isRewritten) {
            storeOriginalTexts();
        }
        
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 10 });
        
        // Process text elements in parallel with concurrency limit
        const elementsToRewrite = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, h5, h6'))
            .filter(el => 
                isVisible(el) && 
                !isInNav(el) && 
                el.textContent.trim().length > 100 &&
                !originalTexts.has(el) // Only process elements not already processed
            );

        let completedCount = 0;
        const totalCount = elementsToRewrite.length;
        
        const rewritePromises = elementsToRewrite.map(el => async () => {
            if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            activeRequests++;
            try {
                const originalText = extractTextWithLinks(el);
                
                // Only send the request if the text is substantial
                if (originalText.trim().length < 50) {
                    return;
                }

                const newText = await fetchRewrittenText(apiKey, originalText, targetLevel);
                
                // Apply the rewritten text
                if (newText) {
                    // Use the corrected replacement function
                    replaceElementTextSimple(el, newText);
                }
            } catch (error) {
                console.error('Error rewriting element:', error);
            } finally {
                activeRequests--;
                completedCount++;
                const progress = 10 + Math.floor((completedCount / totalCount) * 80);
                chrome.runtime.sendMessage({ action: 'progressUpdate', progress });
            }
        });

        // Run limited parallel processing
        await Promise.all(rewritePromises.map(fn => fn()));
        
        isRewritten = true;
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 100 });
        return { success: true };

    } catch (error) {
        console.error('Rewrite failed:', error);
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 0 });
        return { success: false, error: error.message };
    }
}

// Store original texts for later reset
function storeOriginalTexts() {
    Array.from(document.querySelectorAll('p, h1, h2, h3, h4, h5, h6'))
        .filter(el => isVisible(el) && !isInNav(el) && el.textContent.trim().length > 50)
        .forEach(el => {
            if (!originalTexts.has(el)) {
                originalTexts.set(el, el.innerHTML);
            }
        });
}

// Reset page content to original state
function resetPageContent() {
    originalTexts.forEach((originalHTML, element) => {
        if (document.body.contains(element)) {
            element.innerHTML = originalHTML;
        }
    });
    originalTexts.clear();
    isRewritten = false;
    chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 0 });
}

// Helper to check if element is visible
function isVisible(el) {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
}

// Helper to check if element is inside a navigation element
function isInNav(el) {
    return el.closest('nav, header, footer') !== null;
}

// Extracts text and places markers for link elements
function extractTextWithLinks(element) {
    let originalText = '';
    
    // Use clone to avoid modifying the live DOM during extraction
    const tempElement = element.cloneNode(true);

    Array.from(tempElement.childNodes).forEach((node, index) => {
        if (node.nodeType === Node.TEXT_NODE) {
            originalText += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
            // Use a marker format that can be reliably detected and replaced later
            originalText += ` [[LINK${index}:${node.textContent}]] `; 
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // For other elements, just extract text content
            originalText += node.textContent;
        }
    });

    return originalText;
}


// Reworked function to replace element text while preserving links
function replaceElementTextSimple(element, newText) {
    const originalLinks = {};
    let linkIndex = 0;

    // 1. Collect all original links and replace them with markers in the new text
    const tempElement = element.cloneNode(true);

    Array.from(tempElement.childNodes).forEach((node, index) => {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
            const marker = `[[LINK:${linkIndex}]]`;
            originalLinks[marker] = node.cloneNode(true);
            
            // Replace the entire link node in the new text with the marker
            // This is a complex heuristic, a simpler approach is to ask the model to rewrite 
            // the text without touching the brackets, then we replace the text.
            // However, since the model might have moved link content, we use a simpler strategy here.
            
            // A safer, simpler strategy: we just store the link and replace its *marker* later.
            // We assume the new text is clean text without markers.
            linkIndex++;
        }
    });

    // We now assume the newText does NOT contain link markers and is plain text.
    // The previous implementation tried to re-insert links based on the new text, which caused issues.
    // The only reliable way to preserve links is to replace the element's entire content
    // and rely on a complex heuristic, which often fails.

    // Given the previous failure mode (mashed links), the *safest* way to replace text
    // while keeping links, without a complex AI-assisted link replacement system,
    // is to keep the link elements and wrap the text nodes around them, 
    // but the AI is rewriting the *entire* text.

    // A HEURISTIC FIX (safest for this scenario): 
    // We will replace the entire content with the new text. We must sacrifice the old links
    // because the structure of the rewritten text makes reliable re-insertion impossible.
    // However, if we MUST preserve links, we use the following complex logic:
    
    // ---- COMPLEX, HEURISTICALLY-BASED LINK RE-INSERTION (RISKY BUT PRESERVES LINKS) ----
    
    // 1. Find all links in the original element
    const linksToPreserve = Array.from(element.querySelectorAll('a'));
    
    // 2. Clear the element's content entirely
    element.innerHTML = '';
    
    // 3. Insert the new text content
    const newTextNode = document.createTextNode(newText);
    element.appendChild(newTextNode);
    
    // 4. Heuristically re-insert the links (this is the difficult part)
    // We will re-insert them at the end for simple content, or based on keywords if possible.
    // Since the content is being rewritten, we cannot reliably match the old position.
    
    // The only safe, simple way to avoid mashing is to just append them, 
    // or wrap the new text in a span and append the links.
    
    if (linksToPreserve.length > 0) {
        // Create a container for the new text
        const newTextContainer = document.createElement('span');
        newTextContainer.textContent = newText;
        element.appendChild(newTextContainer);
        
        // Append all the original links after the new text
        linksToPreserve.forEach(link => {
            // Add a space or separator before the link
            element.appendChild(document.createTextNode(' '));
            element.appendChild(link);
        });
        
    } else {
        // If no links, just replace all text
        element.textContent = newText;
    }
    
    // NOTE: This heuristic is not perfect. It will append the links at the end.
    // The only way to reliably re-insert links is to send the original text with markers to the LLM, 
    // and ask the LLM to preserve the markers in the rewritten text.
}

// Fetch rewritten text from the API
async function fetchRewrittenText(apiKey, originalText, targetLevel) {
    const systemPrompt = `You are an expert content simplifier and rewriter. Your task is to rewrite the provided text to match a specific English fluency level (${targetLevel}), while maintaining the core meaning and tone. Keep the output concise and directly corresponding to the input length. Do not add conversational framing or markdown.`;
    const userQuery = `Rewrite the following text for a ${targetLevel} level: "${originalText}"`;
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
    // Use the corrected function here
    const frequencyPenalty = getFrequencyPenaltyForLevel(targetLevel);
    
    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        config: {
            temperature: 0.7,
            frequencyPenalty: frequencyPenalty, // Use the corrected penalty
        }
    };

    let response;
    for (let i = 0; i < 3; i++) { // Retry loop for exponential backoff
        try {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) break;

            // Handle API error statuses
            if (response.status === 429) {
                // Rate limit: wait and retry
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
                continue;
            } else {
                // Other errors (400, 500 etc.)
                throw new Error(`API error: ${response.statusText}`);
            }
        } catch (e) {
            if (i === 2) throw e; // Throw after the last retry
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        }
    }

    if (!response || !response.ok) {
        throw new Error('Failed to fetch rewritten text after multiple retries.');
    }
    
    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    return text;
}

// ========== SUMMARIZE PAGE FUNCTIONALITY ==========

// Main function to summarize page content
async function summarizePageContent(apiKey, targetLevel) {
    try {
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 10 });
        
        const content = extractMainContent();
        const cleanedContent = cleanTextContent(content);

        if (cleanedContent.length < 200) {
            throw new Error('Not enough substantial content found on the page to summarize.');
        }

        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 50 });

        const summary = await fetchSummaryText(apiKey, cleanedContent, targetLevel);

        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 90 });
        
        // Use a safe, readable format for displaying the summary
        const summaryElement = createSummaryOverlay(summary);
        document.body.appendChild(summaryElement);
        
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 100 });
        
        return { success: true, summary: summary };

    } catch (error) {
        console.error('Summarize failed:', error);
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 0 });
        return { success: false, error: error.message };
    }
}

// Fetch summary text from the API
async function fetchSummaryText(apiKey, content, targetLevel) {
    const systemPrompt = `You are an expert summarizer. Your task is to summarize the provided text to match a specific English fluency level (${targetLevel}). The summary must be a single, concise paragraph, maintaining the core meaning. Do not add conversational framing or markdown.`;
    const userQuery = `Summarize the following text for a ${targetLevel} level: "${content}"`;
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        config: {
            temperature: 0.7,
        }
    };

    let response;
    for (let i = 0; i < 3; i++) { // Retry loop for exponential backoff
        try {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
    
    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    return text;
}

// Create a stylish overlay to display the summary
function createSummaryOverlay(summary) {
    // Styling
    const style = {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        border: '1px solid #ccc',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
        zIndex: 10000,
        padding: '25px',
        borderRadius: '12px',
        maxWidth: '90%',
        minWidth: '300px',
        maxHeight: '80%',
        overflowY: 'auto',
        fontFamily: 'Inter, sans-serif',
        color: '#1f2937',
    };

    const overlay = document.createElement('div');
    Object.assign(overlay.style, style);

    const title = document.createElement('h3');
    title.textContent = 'Simplified Summary';
    title.style.margin = '0 0 15px 0';
    title.style.fontSize = '1.5rem';
    title.style.color = '#10b981';

    const content = document.createElement('p');
    content.textContent = summary;
    content.style.whiteSpace = 'pre-wrap';
    content.style.margin = '0 0 20px 0';
    content.style.fontSize = '1.1rem';
    content.style.lineHeight = '1.6';

    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.style.cssText = `
        background-color: #10b981;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 1rem;
        transition: background-color 0.2s;
    `;
    closeButton.onmouseover = () => closeButton.style.backgroundColor = '#059669';
    closeButton.onmouseout = () => closeButton.style.backgroundColor = '#10b981';
    closeButton.onclick = () => overlay.remove();

    overlay.appendChild(title);
    overlay.appendChild(content);
    overlay.appendChild(closeButton);

    return overlay;
}

// Extract all text content from the page
function extractMainContent() {
    // Try to find main content containers first
    const contentSelectors = [
        'article',
        'main',
        '[role="main"]',
        '.content',
        '.main-content',
        '.article-content',
        '.post-content',
        '.story-content',
        '.entry-content'
    ];
    
    for (const selector of contentSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim().length > 200) {
            return element.textContent;
        }
    }
    
    // Fallback: combine all paragraphs and headings
    const textElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
    const content = Array.from(textElements)
        .filter(el => isVisible(el) && !isInNav(el) && el.textContent.trim().length > 50)
        .map(el => el.textContent.trim())
        .join('\n\n');
    
    return content || document.body.textContent;
}

// Clean text content
function cleanTextContent(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .trim();
}

// Listen for download requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'download') {
        chrome.downloads.download({
            url: request.url,
            filename: request.filename,
            saveAs: true
        });
        sendResponse({ success: true });
    }
});

// =========================================================================
// Reworked Functions (The Fixes)
// =========================================================================

/**
 * FIXED: Logic inverted to correctly align with OpenAI API behavior.
 * Positive numbers prevent repetition (for diversity).
 * Negative numbers reward repetition (causing loops like "the the the").
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
    // Default to 0.0 (neutral) if level is unknown
    return penaltyMap[targetLevel] || 0.0;
}


/**
 * Reworked function to replace element text while preserving links.
 * The original function mashed the links together by deleting the separating text nodes.
 * The fix is to clear the element, insert the new text, and then HEURISTICALLY 
 * re-insert the original link elements (a tags) at the end, separated by spaces.
 * This prevents the mashed text issue ("IS-3pike nose") while preserving link functionality.
 * A perfect, in-line re-insertion is impossible without AI assistance for positioning.
 */
function replaceElementTextSimple(element, newText) {
    // 1. Find all links in the original element
    const linksToPreserve = Array.from(element.querySelectorAll('a'));
    
    // 2. Clear the element's content entirely
    element.innerHTML = '';
    
    // 3. Insert the new text content
    // We trim the new text to ensure it's clean
    const trimmedNewText = newText.trim();
    
    if (linksToPreserve.length > 0) {
        // Create a container for the new text
        const newTextNode = document.createTextNode(trimmedNewText);
        element.appendChild(newTextNode);
        
        // Append all the original links after the new text, separated by a space
        linksToPreserve.forEach(link => {
            // Check if the new text contained the old link text (heuristic for re-insertion)
            // A simple append is safest for now
            element.appendChild(document.createTextNode(' '));
            element.appendChild(link);
        });
        
    } else {
        // If no links, just replace all text
        element.textContent = trimmedNewText;
    }
}
