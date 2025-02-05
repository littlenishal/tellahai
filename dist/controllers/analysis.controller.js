"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFindings = exports.analyzeText = void 0;
const supabase_1 = require("../config/supabase");
const gemini_1 = require("../config/gemini");
const analyzeText = async (req, res) => {
    try {
        console.log('Analyze Text Request:', {
            body: req.body,
            query: req.query,
            params: req.params
        });
        const { text, conversation_id, context = 'general financial compliance' } = req.body;
        if (!text) {
            console.error('Missing text content');
            return res.status(400).json({
                error: 'Missing text content',
                details: 'Text content is required in the request body'
            });
        }
        // Gemini analysis
        let result;
        try {
            console.log('Gemini Model Used:', gemini_1.model.model);
            result = await gemini_1.model.generateContent(`
        You are a financial compliance expert specializing in ${context}.
        
        Carefully analyze the following text for potential regulatory risks and compliance issues.

        Context of Review: ${context}

        IMPORTANT INSTRUCTIONS:
        1. ALWAYS return a valid JSON response
        2. Ensure the JSON is properly formatted
        3. Use double quotes for strings
        4. Do not use single quotes
        5. Escape any special characters in strings

        Strictly return a JSON response with this exact structure:
        {
          "risk_level": "low|medium|high",
          "key_risks": [
            "specific risk description 1",
            "specific risk description 2"
          ],
          "remediation_steps": [
            "specific remediation step 1",
            "specific remediation step 2"
          ],
          "context_specific_notes": "Additional insights specific to the given context"
        }

        If you cannot identify risks, return:
        {
          "risk_level": "low",
          "key_risks": [],
          "remediation_steps": [],
          "context_specific_notes": "No significant risks identified"
        }

        Text to analyze:
        ${text}
      `);
        }
        catch (geminiError) {
            console.error('Detailed Gemini API call error:', {
                error: geminiError,
                errorType: typeof geminiError,
                errorName: geminiError instanceof Error ? geminiError.name : 'Unknown',
                errorMessage: geminiError instanceof Error ? geminiError.message : JSON.stringify(geminiError),
                errorStack: geminiError instanceof Error ? geminiError.stack : 'No stack trace',
                modelUsed: gemini_1.model.model
            });
            return res.status(500).json({
                error: 'Failed to analyze text with AI',
                details: geminiError instanceof Error
                    ? geminiError.message
                    : JSON.stringify(geminiError)
            });
        }
        // Process Gemini response
        let responseText = '';
        try {
            // Attempt to extract text from response
            const candidates = result.response.candidates;
            if (!candidates || candidates.length === 0) {
                throw new Error('No candidates in Gemini response');
            }
            const firstCandidate = candidates[0];
            const parts = firstCandidate.content?.parts;
            if (!parts || parts.length === 0) {
                throw new Error('No parts in Gemini response candidate');
            }
            responseText = parts[0].text || '';
            if (!responseText) {
                throw new Error('Empty response text from Gemini');
            }
            console.log('Raw Gemini Response:', responseText);
            // Extract JSON from code block or text
            const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
            const jsonTextMatch = responseText.match(/\{[\s\S]*?\}/);
            let cleanedResponseText = '';
            if (jsonMatch) {
                cleanedResponseText = jsonMatch[1].trim();
            }
            else if (jsonTextMatch) {
                cleanedResponseText = jsonTextMatch[0].trim();
            }
            else {
                cleanedResponseText = responseText.trim();
            }
            console.log('Cleaned Response Text:', cleanedResponseText);
            // Safely parse the response text
            let findings;
            try {
                findings = JSON.parse(cleanedResponseText);
            }
            catch (parseError) {
                console.error('Failed to parse response text:', {
                    responseText: cleanedResponseText,
                    parseError,
                    responseLength: cleanedResponseText.length
                });
                // Additional parsing attempts
                try {
                    // Try to fix common JSON parsing issues
                    const fixedResponseText = cleanedResponseText
                        .replace(/(['"])?([a-z0-9A-Z_]+)(['"])?:/g, '"$2":') // Add quotes to keys
                        .replace(/'/g, '"'); // Replace single quotes with double quotes
                    findings = JSON.parse(fixedResponseText);
                }
                catch (secondParseError) {
                    console.error('Secondary parsing attempt failed:', {
                        secondParseError,
                        originalText: cleanedResponseText
                    });
                    throw new Error('Invalid JSON response from Gemini');
                }
            }
            console.log('Parsed Findings:', findings);
            // Store message and findings
            const { data: message, error: messageError } = await supabase_1.supabase
                .from('messages')
                .insert([{
                    conversation_id,
                    is_ai_response: true,
                    content: JSON.stringify(findings)
                }])
                .select()
                .single();
            if (messageError) {
                console.error('Supabase message insert error:', messageError);
                return res.status(500).json({
                    error: 'Failed to store analysis',
                    details: messageError instanceof Error
                        ? messageError.message
                        : JSON.stringify(messageError)
                });
            }
            res.json({ message_id: message.id, findings });
        }
        catch (parseError) {
            console.error('Parsing Error:', parseError);
            console.error('Raw Gemini Response:', responseText);
            return res.status(400).json({
                error: 'Failed to parse analysis results',
                details: parseError instanceof Error
                    ? parseError.message
                    : (typeof parseError === 'object'
                        ? JSON.stringify(parseError)
                        : String(parseError))
            });
        }
    }
    catch (error) {
        console.error('Unexpected Error in Text Analysis:', error);
        res.status(500).json({
            error: 'Unexpected error during text analysis',
            details: error instanceof Error
                ? error.message
                : (typeof error === 'object'
                    ? JSON.stringify(error)
                    : String(error))
        });
    }
};
exports.analyzeText = analyzeText;
const getFindings = async (req, res) => {
    try {
        const { messageId } = req.params;
        console.log('Fetching findings for messageId:', messageId);
        // First, verify the message exists and get its details
        const { data: messageData, error: messageError } = await supabase_1.supabase
            .from('messages')
            .select('*')
            .eq('id', messageId)
            .single();
        console.log('Message Query Result:', {
            messageData,
            messageError
        });
        if (messageError) {
            return res.status(404).json({
                error: 'Message not found',
                details: messageError.message
            });
        }
        // Check if the findings might be stored in the message content itself
        if (messageData.content) {
            try {
                const parsedContent = typeof messageData.content === 'string'
                    ? JSON.parse(messageData.content)
                    : messageData.content;
                // Check if the parsed content has findings-like structure
                if (parsedContent.risk_level || parsedContent.key_risks) {
                    return res.json({
                        findings: parsedContent,
                        message_id: messageId,
                        created_at: messageData.created_at
                    });
                }
            }
            catch (parseError) {
                console.error('Error parsing message content:', parseError);
            }
        }
        // Then, try to get compliance findings
        const { data: findingsData, error } = await supabase_1.supabase
            .from('compliance_findings')
            .select('*')
            .eq('message_id', messageId);
        console.log('Findings Query Result:', {
            findingsData,
            error
        });
        if (error) {
            return res.status(500).json({
                error: 'Failed to fetch findings',
                details: error.message
            });
        }
        // If no findings found in compliance_findings, check message content again
        if (!findingsData || findingsData.length === 0) {
            console.warn(`No findings found for message ${messageId}. Checking message content.`);
            // Fallback to returning message content if it seems like findings
            if (messageData.content) {
                try {
                    const parsedContent = typeof messageData.content === 'string'
                        ? JSON.parse(messageData.content)
                        : messageData.content;
                    if (parsedContent.risk_level || parsedContent.key_risks) {
                        return res.json({
                            findings: parsedContent,
                            message_id: messageId,
                            created_at: messageData.created_at
                        });
                    }
                }
                catch (parseError) {
                    console.error('Error parsing message content as findings:', parseError);
                }
            }
            return res.status(404).json({
                error: 'No findings available',
                details: `No compliance findings found for message ${messageId}`,
                debug: {
                    messageData,
                    findingsData
                }
            });
        }
        // If multiple findings exist, return all of them
        const parsedFindings = findingsData.map(finding => {
            try {
                return {
                    findings: typeof finding.content === 'string'
                        ? JSON.parse(finding.content)
                        : finding.content,
                    message_id: messageId,
                    created_at: finding.created_at,
                    id: finding.id
                };
            }
            catch (parseError) {
                console.error(`Failed to parse finding ${finding.id}:`, parseError);
                return null;
            }
        }).filter(finding => finding !== null);
        // If no valid findings after parsing
        if (parsedFindings.length === 0) {
            return res.status(500).json({
                error: 'Invalid findings format',
                details: 'Unable to parse any findings'
            });
        }
        // Return findings
        res.json(parsedFindings.length === 1 ? parsedFindings[0] : parsedFindings);
    }
    catch (error) {
        console.error('Error fetching findings:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        res.status(500).json({
            error: 'Failed to fetch findings',
            details: errorMessage
        });
    }
};
exports.getFindings = getFindings;
