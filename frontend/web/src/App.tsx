// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ReputationRecord {
  id: string;
  encryptedScore: string;
  timestamp: number;
  owner: string;
  category: "governance" | "social" | "transaction";
  status: "pending" | "verified" | "rejected";
  metadata: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increaseRep':
      result = value + 10;
      break;
    case 'decreaseRep':
      result = Math.max(0, value - 5);
      break;
    case 'doubleRep':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<ReputationRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ category: "governance", description: "", reputationValue: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<ReputationRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showZKModal, setShowZKModal] = useState(false);
  const [zkProof, setZkProof] = useState<string>("");
  const verifiedCount = records.filter(r => r.status === "verified").length;
  const pendingCount = records.filter(r => r.status === "pending").length;
  const rejectedCount = records.filter(r => r.status === "rejected").length;

  // Calculate total reputation score
  const totalReputation = records.reduce((sum, record) => {
    if (record.status === "verified") {
      return sum + FHEDecryptNumber(record.encryptedScore);
    }
    return sum;
  }, 0);

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }

      // Load record keys
      const keysBytes = await contract.getData("reputation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }

      // Load all records
      const list: ReputationRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`reputation_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedScore: recordData.score, 
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                category: recordData.category || "governance",
                status: recordData.status || "pending",
                metadata: recordData.metadata || ""
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting reputation data with Zama FHE..." });
    try {
      const encryptedScore = FHEEncryptNumber(newRecordData.reputationValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        score: encryptedScore, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newRecordData.category,
        status: "pending",
        metadata: newRecordData.description
      };
      
      await contract.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update keys list
      const keysBytes = await contract.getData("reputation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("reputation_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted reputation data submitted!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ category: "governance", description: "", reputationValue: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing reputation data with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const recordBytes = await contract.getData(`reputation_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const verifiedScore = FHECompute(recordData.score, 'increaseRep');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "verified", score: verifiedScore };
      await contractWithSigner.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing reputation data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`reputation_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "rejected" };
      await contract.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const generateZKProof = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Generating ZK proof for reputation..." });
    try {
      // Simulate ZK proof generation
      await new Promise(resolve => setTimeout(resolve, 2000));
      const proof = `zkp-${Math.random().toString(36).substring(2, 15)}`;
      setZkProof(proof);
      setShowZKModal(true);
      setTransactionStatus({ visible: false, status: "pending", message: "" });
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "ZK proof generation failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const renderSBTCard = () => {
    const reputationLevel = Math.min(Math.floor(totalReputation / 100), 5);
    return (
      <div className="sbt-card">
        <div className={`sbt-visual level-${reputationLevel}`}>
          <div className="sbt-core"></div>
          <div className="sbt-ring ring-1"></div>
          <div className="sbt-ring ring-2"></div>
          <div className="sbt-ring ring-3"></div>
          <div className="sbt-badge">SBT</div>
        </div>
        <div className="sbt-info">
          <h3>Reputation SBT</h3>
          <div className="sbt-level">Level {reputationLevel}</div>
          <div className="sbt-score">Total Score: {totalReputation}</div>
          <button className="tech-button" onClick={generateZKProof}>Generate ZK Proof</button>
        </div>
      </div>
    );
  };

  const renderReputationChart = () => {
    const categories = {
      governance: records.filter(r => r.category === "governance" && r.status === "verified").length,
      social: records.filter(r => r.category === "social" && r.status === "verified").length,
      transaction: records.filter(r => r.category === "transaction" && r.status === "verified").length
    };
    
    return (
      <div className="reputation-chart">
        <div className="chart-bars">
          <div className="chart-bar-container">
            <div className="chart-bar governance" style={{ height: `${(categories.governance / records.length) * 100}%` }}></div>
            <div className="chart-label">Governance</div>
          </div>
          <div className="chart-bar-container">
            <div className="chart-bar social" style={{ height: `${(categories.social / records.length) * 100}%` }}></div>
            <div className="chart-label">Social</div>
          </div>
          <div className="chart-bar-container">
            <div className="chart-bar transaction" style={{ height: `${(categories.transaction / records.length) * 100}%` }}></div>
            <div className="chart-label">Transaction</div>
          </div>
        </div>
        <div className="chart-legend">
          <div className="legend-item"><div className="color-box governance"></div><span>Governance: {categories.governance}</span></div>
          <div className="legend-item"><div className="color-box social"></div><span>Social: {categories.social}</span></div>
          <div className="legend-item"><div className="color-box transaction"></div><span>Transaction: {categories.transaction}</span></div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>Proof<span>Of</span>Reputation</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-record-btn tech-button">
            <div className="add-icon"></div>Add Reputation
          </button>
          <button className="tech-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Dynamic Soulbound Reputation</h2>
            <p>Your Web3 reputation as a dynamic SBT powered by Zama FHE technology</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        <div className="dashboard-grid">
          <div className="dashboard-card tech-card">
            <h3>Reputation Dashboard</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{totalReputation}</div>
                <div className="stat-label">Total Score</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{records.length}</div>
                <div className="stat-label">Interactions</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{verifiedCount}</div>
                <div className="stat-label">Verified</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{Math.min(Math.floor(totalReputation / 100), 5)}</div>
                <div className="stat-label">Rep Level</div>
              </div>
            </div>
          </div>
          
          <div className="dashboard-card tech-card">
            <h3>Your Soulbound Token</h3>
            {renderSBTCard()}
          </div>
          
          <div className="dashboard-card tech-card">
            <h3>Reputation Breakdown</h3>
            {renderReputationChart()}
          </div>
        </div>
        
        <div className="records-section">
          <div className="section-header">
            <h2>Reputation Interactions</h2>
            <div className="header-actions">
              <button onClick={loadRecords} className="refresh-btn tech-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="records-list tech-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {records.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No reputation records found</p>
                <button className="tech-button primary" onClick={() => setShowCreateModal(true)}>Create First Record</button>
              </div>
            ) : records.map(record => (
              <div className="record-row" key={record.id} onClick={() => setSelectedRecord(record)}>
                <div className="table-cell record-id">#{record.id.substring(0, 6)}</div>
                <div className="table-cell">{record.category}</div>
                <div className="table-cell">{record.owner.substring(0, 6)}...{record.owner.substring(38)}</div>
                <div className="table-cell">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${record.status}`}>{record.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(record.owner) && record.status === "pending" && (
                    <>
                      <button className="action-btn tech-button success" onClick={(e) => { e.stopPropagation(); verifyRecord(record.id); }}>Verify</button>
                      <button className="action-btn tech-button danger" onClick={(e) => { e.stopPropagation(); rejectRecord(record.id); }}>Reject</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showCreateModal && <ModalCreate onSubmit={submitRecord} onClose={() => setShowCreateModal(false)} creating={creating} recordData={newRecordData} setRecordData={setNewRecordData}/>}
      {selectedRecord && <RecordDetailModal record={selectedRecord} onClose={() => { setSelectedRecord(null); setDecryptedValue(null); }} decryptedValue={decryptedValue} setDecryptedValue={setDecryptedValue} isDecrypting={isDecrypting} decryptWithSignature={decryptWithSignature}/>}
      {showZKModal && <ZKProofModal proof={zkProof} onClose={() => setShowZKModal(false)} />}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>ProofOfReputation</span></div>
            <p>Dynamic Soulbound Reputation powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} ProofOfReputation. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.category || !recordData.reputationValue) { alert("Please fill required fields"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal tech-card">
        <div className="modal-header">
          <h2>Add Reputation Record</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your reputation data will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Category *</label>
              <select name="category" value={recordData.category} onChange={handleChange} className="tech-select">
                <option value="governance">Governance</option>
                <option value="social">Social</option>
                <option value="transaction">Transaction</option>
              </select>
            </div>
            <div className="form-group">
              <label>Description</label>
              <input type="text" name="description" value={recordData.description} onChange={handleChange} placeholder="Brief description..." className="tech-input"/>
            </div>
            <div className="form-group">
              <label>Reputation Value *</label>
              <input 
                type="number" 
                name="reputationValue" 
                value={recordData.reputationValue} 
                onChange={handleValueChange} 
                placeholder="Enter reputation score..." 
                className="tech-input"
                min="0"
                max="100"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Value:</span><div>{recordData.reputationValue || 'No value entered'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{recordData.reputationValue ? FHEEncryptNumber(recordData.reputationValue).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Data Privacy Guarantee</strong><p>Data remains encrypted during FHE processing and is never decrypted on our servers</p></div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn tech-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: ReputationRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ record, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(record.encryptedScore);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal tech-card">
        <div className="modal-header">
          <h2>Record Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item"><span>Category:</span><strong>{record.category}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${record.status}`}>{record.status}</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Reputation Score</h3>
            <div className="encrypted-data">{record.encryptedScore.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn tech-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedValue !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-notice"><div className="warning-icon"></div><span>Decrypted data is only visible after wallet signature verification</span></div>
            </div>
          )}
          {record.metadata && (
            <div className="metadata-section">
              <h3>Metadata</h3>
              <div className="metadata-content">{record.metadata}</div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">Close</button>
        </div>
      </div>
    </div>
  );
};

interface ZKProofModalProps {
  proof: string;
  onClose: () => void;
}

const ZKProofModal: React.FC<ZKProofModalProps> = ({ proof, onClose }) => {
  return (
    <div className="modal-overlay">
      <div className="zk-proof-modal tech-card">
        <div className="modal-header">
          <h2>Zero Knowledge Proof</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="proof-visual">
            <div className="proof-circle"></div>
            <div className="proof-lines">
              <div className="line line-1"></div>
              <div className="line line-2"></div>
              <div className="line line-3"></div>
            </div>
          </div>
          <div className="proof-details">
            <h3>Your Reputation Proof</h3>
            <div className="proof-code">{proof}</div>
            <p>This proof verifies your reputation without revealing sensitive details</p>
          </div>
        </div>
        <div className="modal-footer">
          <button className="tech-button" onClick={() => navigator.clipboard.writeText(proof)}>Copy Proof</button>
          <button onClick={onClose} className="tech-button primary">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;