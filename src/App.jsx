import React, { useState, useEffect } from 'react';
import * as XLSX from "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs";
import { Upload, Send } from 'lucide-react';

// Custom CSS for the loading spinner
const loadingSpinnerStyle = `
.spinner {
    border: 4px solid rgba(0, 0, 0, 0.1);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border-left-color: #3b82f6; /* blue-500 */
    animation: spin 1s ease infinite;
}
@keyframes spin {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(360deg);
    }
}
`;

const LoadingSpinner = () => (
    <div className="flex items-center justify-center p-4">
        <style>{loadingSpinnerStyle}</style>
        <div className="spinner"></div>
    </div>
);

const App = () => {
    // State management for the application
    const [fileData, setFileData] = useState({});
    const [files, setFiles] = useState([]);
    const [chatHistory, setChatHistory] = useState([]);
    const [showChat, setShowChat] = useState(false);
    const [botIsTyping, setBotIsTyping] = useState(false);
    const [modal, setModal] = useState({ isVisible: false, message: '' });
    const [features, setFeatures] = useState([]);
    const [featuresLoading, setFeaturesLoading] = useState(false);
    const [processingStarted, setProcessingStarted] = useState(false);
    const [taskSelected, setTaskSelected] = useState(false);
    const [labelsInput, setLabelsInput] = useState('');
    const [labelDescription, setLabelDescription] = useState('');
    const [labelsSubmitted, setLabelsSubmitted] = useState(false);
    const [selectedTask, setSelectedTask] = useState('');
    const [isFewShotSelected, setIsFewShotSelected] = useState(false);
    const [trainingFiles, setTrainingFiles] = useState([]);
    const [testingFiles, setTestingFiles] = useState([]);
    const [groundTruth, setGroundTruth] = useState({});
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [selectedReasoningApproach, setSelectedReasoningApproach] = useState('');
    const [isChainOfThoughtSelected, setIsChainOfThoughtSelected] = useState(false);
    const [cotInstruction, setCotInstruction] = useState('');
    const [cotSteps, setCotSteps] = useState([]);
    const [showPrompt, setShowPrompt] = useState(false);

    // Hardcoded API key for demonstration purposes. In a real app, this should be handled securely.
    const apiKey =  import.meta.env.VITE_OPENAI_API_KEY; // API key for the LLM

    // Pre-written chat prompts
    const preWrittenPrompts = {
        'Classification (time series)': [
            "Zero-shot approach",
            "Few-shot Approach",
            "Chain of Thought Reasoning Approach"
        ],
        'Classification (time series + vision)': [
            "Zero-shot approach",
            "Few-shot Approach",
            "Chain of Thought Reasoning Approach"
        ],
        'Feature extraction': [
            "List all numerical features.",
            "List all categorical features.",
            "Generate new features based on existing ones."
        ]
    };

    // Function to display modal message
    const showModal = (message) => {
        setModal({ isVisible: true, message });
    };

    // Function to hide modal message
    const hideModal = () => {
        setModal({ isVisible: false, message: '' });
    };

    // Function to parse CSV data
    const parseCsv = (data) => {
        const lines = data.split('\n').filter(line => line.trim() !== '');
        if (lines.length === 0) return null;
        const headers = lines[0].split(',').map(h => h.trim());
        const rows = lines.slice(1).map(line => {
            const values = line.split(',').map(v => v.trim());
            return headers.reduce((obj, header, index) => {
                obj[header] = values[index] || null;
                return obj;
            }, {});
        });
        return { headers, rows };
    };

    // Function to parse XLSX data
    const parseXlsx = (data) => {
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) return null;
        const worksheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        if (json.length === 0) return null;
        const headers = json[0];
        const rows = json.slice(1).map(row => {
            return headers.reduce((obj, header, index) => {
                obj[header] = row[index] || null;
                return obj;
            }, {});
        });
        return { headers, rows };
    };

    // Fetches feature recommendations from the LLM
    const getFeatureRecommendations = async (data) => {
        setFeaturesLoading(true);
        let prompt = `Given the following data headers and a sample of the data, generate a comprehensive, comma-separated list of as many relevant features as possible that would be useful for a data analysis task. Provide only the feature names, comma separated. Do not provide any explanations or additional text.`;
        
        const payload = {
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
        };

        let retries = 0;
        const maxRetries = 3;
        const delay = (ms) => new Promise(res => setTimeout(res, ms));

        const fetchResponse = async () => {
            const apiUrl = `https://api.openai.com/v1/chat/completions`;
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) {
                    throw new Error(`API response error: ${response.statusText}`);
                }
                const result = await response.json();
                
                if (result.choices && result.choices.length > 0 && result.choices[0].message) {
                    const botResponse = result.choices[0].message.content;
                    const featuresList = botResponse.split(',').map(feature => feature.trim()).filter(feature => feature !== "");
                    setFeatures(featuresList);
                } else {
                    console.error("Unexpected API response format for feature extraction:", result);
                    setFeatures(['Could not generate recommendations.']);
                }
            } catch (error) {
                if (retries < maxRetries) {
                    retries++;
                    await delay(Math.pow(2, retries) * 1000); // Exponential backoff
                    await fetchResponse();
                } else {
                    console.error("Failed to fetch feature recommendations from OpenAI API:", error);
                    setFeatures(['Failed to get recommendations. Please try again.']);
                }
            } finally {
                setFeaturesLoading(false);
            }
        };
        fetchResponse();
    };

    // Function to export classification results to an XLSX file
    const exportToXLSX = (results) => {
        // Parse the results string into an array of objects
        const lines = results.split('\n').filter(line => line.trim() !== '');
        const data = [
            ['Filename', 'Classification', 'Ground Truth'], // Headers for the new spreadsheet
            ...lines.map(line => {
                const parts = line.split(':');
                const fileName = parts[0].trim();
                const classification = parts.length > 1 ? parts[1].trim() : 'N/A';
                const truth = groundTruth[fileName] || 'N/A';
                return [fileName, classification, truth];
            })
        ];

        // Create a new workbook and add the data
        const ws = XLSX.utils.aoa_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Classification Results");

        // Generate the XLSX file and trigger download
        XLSX.writeFile(wb, "classification_results.xlsx");
    };

    // Handle file uploads
    const handleFileChange = (event) => {
        const selectedFiles = Array.from(event.target.files);
        if (selectedFiles.length === 0) {
            showModal("Please select one or more files to upload.");
            return;
        }
        setFiles(selectedFiles);
        setFileData({});
        setFeatures([]);
        setFeaturesLoading(false);
        setProcessingStarted(false);
        setTaskSelected(false); // Reset task state
        setLabelsSubmitted(false);
        setIsFewShotSelected(false);
        setTrainingFiles([]);
        setTestingFiles([]);
        setGroundTruth({});
        setIsChainOfThoughtSelected(false);
        setCotSteps([]);
    };

    // Handle button click to confirm files and start processing
    const handleConfirmUpload = async () => {
        setProcessingStarted(true);
        setFeaturesLoading(true);

        const processedData = {};
        const processingPromises = files.map(file => {
            return new Promise((resolve, reject) => {
                const fileExt = file.name.split('.').pop().toLowerCase();
                const reader = new FileReader();

                reader.onload = (e) => {
                    try {
                        let parsedContent = null;
                        if (fileExt === 'csv') {
                            parsedContent = parseCsv(e.target.result);
                        } else if (fileExt === 'xlsx') {
                            parsedContent = parseXlsx(e.target.result);
                        } else if (fileExt === 'h5') {
                            showModal(`The file "${file.name}" is an .h5 file. This application does not support client-side processing of .h5 files.`);
                            reject(new Error(".h5 file not supported"));
                            return;
                        }

                        if (parsedContent) {
                            processedData[file.name] = parsedContent;
                            resolve();
                        } else {
                            reject(new Error("Failed to parse file"));
                        }
                    } catch (error) {
                        showModal(`An error occurred while parsing file "${file.name}".`);
                        reject(error);
                    }
                };

                // Read file as ArrayBuffer for xlsx or as text for csv
                if (fileExt === 'xlsx') {
                    reader.readAsArrayBuffer(file);
                } else if (fileExt === 'csv') {
                    reader.readAsText(file);
                } else {
                    reject(new Error("Unsupported file type"));
                }
            });
        });

        try {
            await Promise.all(processingPromises);
            setFileData(processedData);
            getFeatureRecommendations(processedData);
        } catch (error) {
            console.error("File processing failed:", error);
            setFeaturesLoading(false);
            setProcessingStarted(false); // Reset in case of an error
        }
    };
    
// Function to run the API call after confirmation
const runAnalysis = async () => {
    setShowConfirmation(false);
    setBotIsTyping(true);

    // Construct the comprehensive prompt based on selected reasoning approach
    let prompt;
    if (selectedReasoningApproach === "Few-shot Approach") {
        // Updated code for Few-shot Approach
        const trainingDataPrompt = trainingFiles.map(file => {
            const data = fileData[file];
            const sampleHeaders = data.headers.join(', ');
            const sampleRows = data.rows.slice(0, 5);
            const groundTruthLabel = groundTruth[file];
            
            // Format the training example with headers, sample data, and the ground truth label.
            return `File: ${file}\nHeaders: ${sampleHeaders}\nSample Data: ${JSON.stringify(sampleRows)}\nLabel: ${groundTruthLabel}`;
        }).join('\n\n');

        const testingFilesPrompt = testingFiles.map(file => `File: ${file}`).join(', ');

        prompt = `You are a helpful assistant for data analysis tasks. Your task is to classify the provided testing files using the training files as examples.

You are provided with several exemplars of data, each with a ground truth label. Analyze the data and its label to understand the patterns.

Exemplars (Training Data):
${trainingDataPrompt}

The overall classification labels are: [${labelsInput}].
The description of these labels is: ${labelDescription}.

Using these exemplars, classify the following testing files:
${testingFilesPrompt}

For each testing file, consider the provided exemplars and apply the patterns you identified to determine the correct label.

Output ONLY the results in the format:
Filename: Label
For example:
example1.xlsx: Label1
example2.xlsx: Label2
`;
    } else if (selectedReasoningApproach === "Chain of Thought Reasoning Approach") {
        const cotPrompt = cotSteps.map((step, index) => `Step ${index + 1}: ${step}`).join('\n');
        prompt = `You are a helpful assistant for data analysis tasks. Your task is to classify the provided files.
        
Using a Chain of Thought approach, classify the following data based on the provided instructions and steps.

Instructions:
${cotPrompt}

I have uploaded the following files:
${Object.keys(fileData).map(fileName => `File: ${fileName}`).join(', ')}.

The classification labels are: [${labelsInput}].
The description of these labels is: ${labelDescription}.

Output ONLY the results in the format:
Filename: Label
For example:
example1.xlsx: Label1
example2.xlsx: Label2
example3.xlsx: Label3
`;
    } else {
        prompt = `You are a helpful assistant for data analysis tasks. Your task is to classify the provided files.
        
Using a ${selectedReasoningApproach}, classify the following data.

I have uploaded the following files:
${Object.keys(fileData).map(fileName => `File: ${fileName}`).join(', ')}.

The classification labels are: [${labelsInput}].
The description of these labels is: ${labelDescription}.

Output ONLY the results in the format:
Filename: Label
For example:
example1.xlsx: Label1
example2.xlsx: Label2
example3.xlsx: Label3
`;
      }

      if (showPrompt) {
          setChatHistory(prev => [...prev, { sender: 'bot', message: `Prompt sent to API:\n\n\`\`\`\n${prompt}\n\`\`\`` }]);
      }

      const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: prompt }],
      };

      let retries = 0;
      const maxRetries = 3;
      const delay = (ms) => new Promise(res => setTimeout(res, ms));

      const fetchResponse = async () => {
          const apiUrl = `https://api.openai.com/v1/chat/completions`;
          try {
              const response = await fetch(apiUrl, {
                  method: 'POST',
                  headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${apiKey}`
                  },
                  body: JSON.stringify(payload)
              });
              if (!response.ok) {
                  throw new Error(`API response error: ${response.statusText}`);
              }
              const result = await response.json();

              if (result.choices && result.choices.length > 0 && result.choices[0].message) {
                  const botResponse = result.choices[0].message.content;
                  setChatHistory(prev => [...prev, { sender: 'bot', message: botResponse }]);

                  if (selectedTask.includes('Classification')) {
                      exportToXLSX(botResponse);
                  }
              } else {
                  console.error("Unexpected API response format:", result);
                  setChatHistory(prev => [...prev, { sender: 'bot', message: "Sorry, I couldn't get a response. Please try again." }]);
              }
          } catch (error) {
              if (retries < maxRetries) {
                  retries++;
                  await delay(Math.pow(2, retries) * 1000); // Exponential backoff
                  await fetchResponse();
              } else {
                  console.error("Failed to fetch from OpenAI API after multiple retries:", error);
                  setChatHistory(prev => [...prev, { sender: 'bot', message: "I'm having trouble connecting to the service. Please try again later." }]);
              }
          } finally {
              setBotIsTyping(false);
              setIsFewShotSelected(false);
              setIsChainOfThoughtSelected(false);
          }
      };
      
      fetchResponse();
  };
    // Handles a pre-written prompt button click
    const handlePromptClick = (reasoningApproach) => {
        if (botIsTyping) return;
        setSelectedReasoningApproach(reasoningApproach);

        if (reasoningApproach === "Few-shot Approach") {
          setIsFewShotSelected(true);
          // This is the new line of code that pre-populates the training files.
          setTrainingFiles(Object.keys(fileData));
          // We also want to clear testing files just in case
          setTestingFiles([]);
          setChatHistory(prev => [...prev, { sender: 'user', message: reasoningApproach }]);
          setChatHistory(prev => [...prev, { sender: 'bot', message: `All available files have been pre-selected as training files. You can now select files for testing.` }]);
          return;
        }


        if (reasoningApproach === "Chain of Thought Reasoning Approach") {
            setIsChainOfThoughtSelected(true);
            setChatHistory(prev => [...prev, { sender: 'user', message: reasoningApproach }]);
            setChatHistory(prev => [...prev, { sender: 'bot', message: `Please enter the intermediary steps or rules for the classification task.` }]);
            return;
        }
        
        setChatHistory(prev => [...prev, { sender: 'user', message: reasoningApproach }]);
        setShowConfirmation(true);
    };

    // Handles few-shot file selection submission
    const handleFewShotSubmit = () => {
        if (trainingFiles.length === 0 || testingFiles.length === 0) {
            showModal("Please select at least one file for training and one for testing.");
            return;
        }

        setChatHistory(prev => [...prev, { sender: 'user', message: `Training: ${trainingFiles.join(', ')}\nTesting: ${testingFiles.join(', ')}` }]);
        setSelectedReasoningApproach("Few-shot Approach");
        setShowConfirmation(true);
    };

    // Handles a task selection button click
    const handleTaskSelection = (task) => {
        setSelectedTask(task);
        setTaskSelected(true);
        setLabelsSubmitted(false);
        setIsFewShotSelected(false);
        setChatHistory(prev => [...prev, { sender: 'user', message: `I have selected: ${task}` }]);
        setChatHistory(prev => [...prev, { sender: 'bot', message: `Thank you for selecting "${task}".` }]);
        if (task === "Feature extraction") {
            setChatHistory(prev => [...prev, { sender: 'bot', message: 'Here are some questions you can ask about your data.' }]);
        } else {
            setChatHistory(prev => [...prev, { sender: 'bot', message: 'Please provide the data labels and a brief description for your classification task.' }]);
        }
    };

    const handleLabelSubmit = (e) => {
        e.preventDefault();
        setLabelsSubmitted(true);
        setChatHistory(prev => [
            ...prev,
            { sender: 'user', message: `Labels: ${labelsInput}` },
            { sender: 'user', message: `Description: ${labelDescription}` }
        ]);
        setChatHistory(prev => [...prev, { sender: 'bot', message: 'Thank you. Now, please select a reasoning approach.' }]);
    };

    const handleGroundTruthChange = (fileName, label) => {
        setGroundTruth(prev => ({ ...prev, [fileName]: label }));
    };

    const handleTrainingFileSelection = (fileName) => {
        setTrainingFiles(prev => {
            if (prev.includes(fileName)) {
                return prev.filter(f => f !== fileName);
            } else {
                return [...prev, fileName];
            }
        });
        setTestingFiles(prev => prev.filter(f => f !== fileName));
    };

    const handleTestingFileSelection = (fileName) => {
        setTestingFiles(prev => {
            if (prev.includes(fileName)) {
                return prev.filter(f => f !== fileName);
            } else {
                return [...prev, fileName];
            }
        });
        setTrainingFiles(prev => prev.filter(f => f !== fileName));
    };
    
    const handleCotInstructionSubmit = (e) => {
        e.preventDefault();
        if (cotInstruction.trim()) {
            setCotSteps(prev => [...prev, cotInstruction]);
            setCotInstruction('');
        }
    };
    
    const handleCotConfirm = () => {
        if (cotSteps.length > 0) {
            setChatHistory(prev => [...prev, { sender: 'user', message: `Chain of Thought steps submitted: ${cotSteps.map((step, index) => `Step ${index + 1}: ${step}`).join('; ')}` }]);
            setShowConfirmation(true);
        } else {
            showModal("Please add at least one instruction or rule.");
        }
    };

    // Resets the application to the initial state
    const resetApp = () => {
        setFileData({});
        setFiles([]);
        setChatHistory([]);
        setShowChat(false);
        setBotIsTyping(false);
        setModal({ isVisible: false, message: '' });
        setFeatures([]);
        setFeaturesLoading(false);
        setProcessingStarted(false);
        setTaskSelected(false);
        setLabelsInput('');
        setLabelDescription('');
        setLabelsSubmitted(false);
        setSelectedTask('');
        setIsFewShotSelected(false);
        setTrainingFiles([]);
        setTestingFiles([]);
        setGroundTruth({});
        setShowConfirmation(false);
        setSelectedReasoningApproach('');
        setIsChainOfThoughtSelected(false);
        setCotSteps([]);
        setCotInstruction('');
        setShowPrompt(false);
    };

    // useEffect to handle scrolling to the bottom of the chat container
    useEffect(() => {
        const chatContainer = document.getElementById('chat-container');
        if (chatContainer) {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
    }, [chatHistory]);

    // useEffect to transition to chat view after data and recommendations are ready
    useEffect(() => {
        if (Object.keys(fileData).length > 0 && features.length > 0 && !featuresLoading && processingStarted) {
            setShowChat(true);
            setChatHistory([{
                sender: 'bot',
                message: `I have successfully processed your files: ${Object.keys(fileData).join(', ')}. What task are you looking to complete?`
            }]);
        }
    }, [fileData, features, featuresLoading, processingStarted]);
    
    const availableLabels = labelsInput.split(',').map(l => l.trim()).filter(l => l !== '');
    const getGroundTruthSummary = () => {
        const truthEntries = Object.entries(groundTruth);
        if (truthEntries.length === 0) return "No ground truth labels provided.";
        return truthEntries.map(([file, label]) => `${file}: ${label}`).join(', ');
    };

    const getCotSummary = () => {
        if (cotSteps.length === 0) return "No intermediary steps provided.";
        return cotSteps.map((step, index) => `Step ${index + 1}: ${step}`).join('; ');
    };

    const confirmationSummary = selectedReasoningApproach === "Few-shot Approach" ? (
        <div className="text-sm text-left space-y-2">
            <p><strong>Task:</strong> {selectedTask}</p>
            <p><strong>Labels:</strong> {labelsInput}</p>
            <p><strong>Label descriptions:</strong> {labelDescription}</p>
            <p><strong>Ground truths:</strong> {getGroundTruthSummary()}</p>
            <p><strong>Method of executing task:</strong> {selectedReasoningApproach}</p>
            <p><strong>Training Files:</strong> {trainingFiles.join(', ')}</p>
            <p><strong>Testing Files:</strong> {testingFiles.join(', ')}</p>
        </div>
    ) : (
        <div className="text-sm text-left space-y-2">
            <p><strong>Task:</strong> {selectedTask}</p>
            <p><strong>Labels:</strong> {labelsInput}</p>
            <p><strong>Label descriptions:</strong> {labelDescription}</p>
            <p><strong>Ground truths:</strong> {getGroundTruthSummary()}</p>
            <p><strong>Method of executing task:</strong> {selectedReasoningApproach}</p>
            {selectedReasoningApproach === "Chain of Thought Reasoning Approach" && (
                <p><strong>Instructions:</strong> {getCotSummary()}</p>
            )}
        </div>
    );

    return (
        <div id="app" className="flex flex-col md:flex-row bg-white rounded-3xl shadow-2xl overflow-hidden w-full max-w-6xl h-[90vh]">
            {!showChat ? (
                // File Upload Area
                <div className="flex-1 p-8 flex flex-col justify-center items-center text-center">
                    <h1 className="text-4xl font-bold text-gray-800 mb-4">LLM-Powered Feature Extraction and Physical Data Classification</h1>
                    <p className="text-gray-600 mb-8">Upload one or more `.csv` or `.xlsx` files to start a conversation.</p>
                    <div className="border-2 border-dashed border-gray-300 rounded-2xl p-8 w-full max-w-md bg-gray-50 transition duration-300 ease-in-out hover:border-blue-400 hover:bg-blue-50">
                        <input type="file" id="file-input" multiple accept=".csv, .xlsx" onChange={handleFileChange} className="hidden" />
                        <label htmlFor="file-input" className="cursor-pointer">
                            <Upload className="mx-auto h-16 w-16 text-blue-400 mb-4" />
                            <p className="text-lg font-medium text-gray-700">Drag & drop files here</p>
                            <p className="text-gray-500 mt-1">or <span className="text-blue-500 font-semibold underline">browse</span> to upload</p>
                        </label>
                    </div>
                    {files.length > 0 && (
                        <div id="file-list" className="mt-6 w-full max-w-md">
                            {files.map((file, index) => (
                                <div key={index} className="flex justify-between items-center p-3 bg-gray-100 rounded-xl mb-2">
                                    <span className="truncate text-gray-700">{file.name}</span>
                                    <span className="text-green-500 font-bold ml-2">✓</span>
                                </div>
                            ))}
                        </div>
                    )}
                    
                    {/* Confirmation Button */}
                    {files.length > 0 && !processingStarted && (
                        <button
                            onClick={handleConfirmUpload}
                            className="mt-6 bg-blue-600 text-white px-6 py-3 rounded-2xl shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors font-semibold"
                        >
                            Confirm and Start Chat
                        </button>
                    )}

                    {/* Recommended Features Section */}
                    {files.length > 0 && processingStarted && (
                        <div id="features-section" className="mt-8 p-6 bg-white rounded-2xl shadow-lg w-full max-w-md">
                            <h2 className="text-xl font-bold text-gray-800 mb-4">Recommended Features</h2>
                            {featuresLoading ? (
                                <div id="features-list-loader" className="text-center text-gray-500">
                                    <LoadingSpinner />
                                    <p>Generating recommendations...</p>
                                </div>
                            ) : (
                                <ul id="features-list" className="list-disc list-inside space-y-2 text-gray-700">
                                    {features.map((feature, index) => (
                                        <li key={index}>{feature}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            ) : (
                // Chat Area
                <div className="flex-1 flex flex-col p-6 bg-slate-50 transition-opacity duration-500 ease-in-out opacity-100">
                    <div className="flex-none pb-4 border-b border-gray-200">
                        <h2 className="text-2xl font-bold text-gray-800">Chat with your data</h2>
                        <p className="text-sm text-gray-500 mt-1">Files loaded: <span className="font-medium">{Object.keys(fileData).join(', ')}</span></p>
                    </div>
                    {/* Chat Messages */}
                    <div id="chat-container" className="flex-1 overflow-y-auto space-y-4 py-4 pr-2">
                        {chatHistory.map((msg, index) => (
                            <div key={index} className={`flex items-start space-x-3 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                                {msg.sender === 'bot' && (
                                    <div className="flex-none h-10 w-10 rounded-full bg-gray-200 text-gray-800 flex items-center justify-center font-bold">Bot</div>
                                )}
                                <div className={`rounded-2xl p-4 max-w-[75%] break-words ${msg.sender === 'user' ? 'bg-blue-500 text-white rounded-br-none' : 'bg-white text-gray-800 border border-gray-200 rounded-bl-none'}`}>
                                    {msg.message}
                                </div>
                                {msg.sender === 'user' && (
                                    <div className="flex-none h-10 w-10 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold">You</div>
                                )}
                            </div>
                        ))}
                        {botIsTyping && (
                            <div className="flex items-start space-x-3 justify-start">
                                <div className="flex-none h-10 w-10 rounded-full bg-gray-200 text-gray-800 flex items-center justify-center font-bold">Bot</div>
                                <div className="rounded-2xl p-4 bg-white text-gray-800 border border-gray-200 rounded-bl-none max-w-[75%]">
                                    <LoadingSpinner />
                                </div>
                            </div>
                        )}
                    </div>
     {/*Prompt Buttons */}
<div className="flex-none mt-4 flex flex-wrap gap-2">
    {!taskSelected ? (
        <div className="flex flex-col w-full space-y-2">
            <h3 className="text-lg font-semibold text-gray-800">What task are you looking to complete?</h3>
            <button onClick={() => handleTaskSelection("Classification (time series)")} className="w-full text-left px-4 py-3 bg-white border border-gray-300 rounded-xl shadow-sm hover:bg-gray-100 transition-colors">
                Classification (time series)
            </button>
            <button onClick={() => handleTaskSelection("Classification (time series + vision)")} className="w-full text-left px-4 py-3 bg-white border border-gray-300 rounded-xl shadow-sm hover:bg-gray-100 transition-colors">
                Classification (time series + vision)
            </button>
            <button onClick={() => handleTaskSelection("Feature extraction")} className="w-full text-left px-4 py-3 bg-white border border-gray-300 rounded-xl shadow-sm hover:bg-gray-100 transition-colors">
                Feature extraction
            </button>
        </div>
    ) : (
        selectedTask.includes('Classification') && !labelsSubmitted ? (
            <form onSubmit={handleLabelSubmit} className="flex flex-col w-full space-y-4">
                <h3 className="text-lg font-semibold text-gray-800">Please provide the data labels and a brief description.</h3>
                <input
                    type="text"
                    placeholder="Input Data Labels (e.g., 'Label1, Label2')"
                    value={labelsInput}
                    onChange={(e) => setLabelsInput(e.target.value)}
                    className="p-3 border-2 border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <textarea
                    placeholder="Describe your labels"
                    value={labelDescription}
                    onChange={(e) => setLabelDescription(e.target.value)}
                    rows="3"
                    className="p-3 border-2 border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                ></textarea>
                <button
                    type="submit"
                    className="bg-blue-600 text-white px-4 py-2 rounded-xl shadow-lg hover:bg-blue-700 transition-colors"
                    disabled={!labelsInput.trim() || !labelDescription.trim()}
                >
                    Submit Labels
                </button>
            </form>
        ) : showConfirmation ? (
            // This is the new centralized confirmation screen
            <div className="flex flex-col w-full space-y-4 p-4 bg-white rounded-2xl shadow-lg">
                <h3 className="text-lg font-bold text-gray-800">Please confirm your entries:</h3>
                <div className="text-sm text-left space-y-2">
                    <p><strong>Task:</strong> {selectedTask}</p>
                    <p><strong>Labels:</strong> {labelsInput}</p>
                    <p><strong>Label descriptions:</strong> {labelDescription}</p>
                    <p><strong>Ground truths:</strong> {getGroundTruthSummary()}</p>
                    <p><strong>Method of executing task:</strong> {selectedReasoningApproach}</p>
                    {selectedReasoningApproach === "Few-shot Approach" && (
                        <>
                            <p><strong>Training Files:</strong> {trainingFiles.join(', ')}</p>
                            <p><strong>Testing Files:</strong> {testingFiles.join(', ')}</p>
                        </>
                    )}
                    {selectedReasoningApproach === "Chain of Thought Reasoning Approach" && (
                        <p><strong>Instructions:</strong> {getCotSummary()}</p>
                    )}
                </div>
                <div className="flex items-center space-x-2">
                    <input
                        type="checkbox"
                        id="show-prompt"
                        checked={showPrompt}
                        onChange={(e) => setShowPrompt(e.target.checked)}
                        className="h-4 w-4 text-blue-600 rounded"
                    />
                    <label htmlFor="show-prompt" className="text-sm text-gray-700">View Prompt</label>
                </div>
                <div className="flex justify-between gap-4 mt-4">
                    <button
                        onClick={resetApp}
                        className="flex-1 px-4 py-2 bg-red-500 text-white rounded-xl shadow-lg hover:bg-red-600 transition-colors font-semibold"
                    >
                        Change Information
                    </button>
                    <button
                        onClick={runAnalysis}
                        className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-xl shadow-lg hover:bg-blue-700 transition-colors font-semibold"
                    >
                        Run Analysis
                    </button>
                </div>
            </div>
        ) : isFewShotSelected ? (
            <div className="flex flex-col w-full space-y-4">
                <h3 className="text-lg font-semibold text-gray-800">Select Training and Testing Files:</h3>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <h4 className="font-medium mb-2">Training Files ({trainingFiles.length})</h4>
                        <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                            {Object.keys(fileData).map(fileName => (
                                <button
                                    key={fileName}
                                    onClick={() => handleTrainingFileSelection(fileName)}
                                    className={`w-full text-left px-4 py-2 border rounded-xl transition-colors ${trainingFiles.includes(fileName) ? 'bg-blue-100 border-blue-400' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
                                >
                                    {fileName}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <h4 className="font-medium mb-2">Testing Files ({testingFiles.length})</h4>
                        <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                            {Object.keys(fileData).map(fileName => (
                                <button
                                    key={fileName}
                                    onClick={() => handleTestingFileSelection(fileName)}
                                    className={`w-full text-left px-4 py-2 border rounded-xl transition-colors ${testingFiles.includes(fileName) ? 'bg-red-100 border-red-400' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
                                >
                                    {fileName}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
                <button
                    onClick={handleFewShotSubmit}
                    className="mt-4 bg-green-600 text-white px-6 py-3 rounded-2xl shadow-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors font-semibold"
                    disabled={trainingFiles.length === 0 || testingFiles.length === 0}
                >
                    Submit Few-shot Task
                </button>
            </div>
        ) : isChainOfThoughtSelected ? (
            <div className="flex flex-col w-full space-y-4 p-4 bg-white rounded-2xl shadow-lg">
                <h3 className="text-lg font-semibold text-gray-800">Enter your intermediary steps/rules:</h3>
                <div className="border border-gray-300 rounded-xl p-4 max-h-40 overflow-y-auto">
                    {cotSteps.length > 0 ? (
                        <ol className="list-decimal list-inside space-y-1 text-gray-700 text-left">
                            {cotSteps.map((step, index) => (
                                <li key={index}>{step}</li>
                            ))}
                        </ol>
                    ) : (
                        <p className="text-gray-500 text-center">No steps added yet.</p>
                    )}
                </div>
                <form onSubmit={handleCotInstructionSubmit} className="flex items-center space-x-2">
                    <input
                        type="text"
                        placeholder="Enter your instruction here..."
                        value={cotInstruction}
                        onChange={(e) => setCotInstruction(e.target.value)}
                        className="flex-1 p-3 border-2 border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                        type="submit"
                        className="p-3 bg-blue-600 text-white rounded-xl shadow-lg hover:bg-blue-700 transition-colors"
                        disabled={!cotInstruction.trim()}
                    >
                        Add
                    </button>
                </form>
                <button
                    onClick={handleCotConfirm}
                    className="mt-4 bg-green-600 text-white px-6 py-3 rounded-2xl shadow-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors font-semibold"
                    disabled={cotSteps.length === 0}
                >
                    Confirm Steps
                </button>
            </div>
        ) : (
            <div className="flex flex-col w-full space-y-4">
                {selectedTask.includes('Classification') && labelsSubmitted && (
                    <div className="w-full p-4 bg-white rounded-2xl shadow-lg">
                        <h4 className="text-lg font-semibold text-gray-800 mb-4">Input Ground Truth Labels</h4>
                        <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                            {Object.keys(fileData).map(fileName => (
                                <div key={fileName} className="flex flex-col space-y-2">
                                    <span className="font-medium text-gray-700">{fileName}</span>
                                    <div className="flex flex-wrap gap-2">
                                        {availableLabels.map(label => (
                                            <button
                                                key={label}
                                                onClick={() => handleGroundTruthChange(fileName, label)}
                                                className={`px-3 py-1 border rounded-full text-sm transition-colors ${groundTruth[fileName] === label ? 'bg-green-500 text-white border-green-500' : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'}`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <div className="flex flex-wrap gap-2">
                    {preWrittenPrompts[selectedTask].map((prompt, index) => (
                        <button
                            key={index}
                            onClick={() => handlePromptClick(prompt)}
                            className="px-4 py-2 bg-gray-200 text-gray-800 rounded-full text-sm font-medium hover:bg-gray-300 transition-colors"
                            disabled={botIsTyping}
                        >
                            {prompt}
                        </button>
                    ))}
                </div>
            </div>
        )
    )}
</div>
                </div>
            )}

            {/* Modal for messages/errors */}
            {modal.isVisible && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                    <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-xl font-bold text-gray-800">Notice</h3>
                            <button onClick={hideModal} className="text-gray-400 hover:text-gray-600 transition-colors">&times;</button>
                        </div>
                        <div className="text-gray-700">{modal.message}</div>
                        <div className="mt-6 flex justify-end">
                            <button onClick={hideModal} className="bg-blue-600 text-white px-4 py-2 rounded-xl hover:bg-blue-700 transition-colors">OK</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default App;
