pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ProofOfReputationFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public currentBatchId;
    bool public batchOpen;

    struct EncryptedReputationData {
        euint32 governanceVotesEnc; // Encrypted number of governance votes
        euint32 positiveReviewsEnc; // Encrypted number of positive reviews
        euint32 negativeReviewsEnc; // Encrypted number of negative reviews
    }
    mapping(uint256 => mapping(address => EncryptedReputationData)) public userReputationData;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ReputationDataSubmitted(address indexed user, uint256 indexed batchId);
    event ReputationUpdateRequested(uint256 indexed requestId, uint256 indexed batchId, address indexed user);
    event ReputationUpdateCompleted(uint256 indexed requestId, uint256 indexed batchId, address indexed user, uint32 reputationScore);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error BatchAlreadyOpen();
    error InvalidBatchId();
    error ReplayAttempt();
    error StateMismatch();
    error DecryptionFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        cooldownSeconds = 60; // Default cooldown: 1 minute
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert BatchAlreadyOpen();
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitReputationData(
        address user,
        euint32 governanceVotesEnc,
        euint32 positiveReviewsEnc,
        euint32 negativeReviewsEnc
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        if (!governanceVotesEnc.isInitialized()) revert DecryptionFailed();
        if (!positiveReviewsEnc.isInitialized()) revert DecryptionFailed();
        if (!negativeReviewsEnc.isInitialized()) revert DecryptionFailed();

        userReputationData[currentBatchId][user] = EncryptedReputationData(governanceVotesEnc, positiveReviewsEnc, negativeReviewsEnc);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ReputationDataSubmitted(user, currentBatchId);
    }

    function requestReputationUpdate(uint256 batchId, address user) external whenNotPaused checkDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatchId();
        EncryptedReputationData storage data = userReputationData[batchId][user];
        if (!data.governanceVotesEnc.isInitialized()) revert DecryptionFailed(); // Check if data exists for this user/batch

        euint32 memory totalInteractionsEnc = data.governanceVotesEnc.add(data.positiveReviewsEnc).add(data.negativeReviewsEnc);
        euint32 memory positiveInteractionsEnc = data.governanceVotesEnc.add(data.positiveReviewsEnc);
        euint32 memory reputationScoreEnc = positiveInteractionsEnc.mul(FHE.asEuint32(100)).div(totalInteractionsEnc);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = reputationScoreEnc.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit ReputationUpdateRequested(requestId, batchId, user);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection ensures a callback for a specific requestId is processed only once.

        DecryptionContext memory ctx = decryptionContexts[requestId];
        if (ctx.stateHash == 0) revert InvalidBatchId(); // Indicates uninitialized or invalid request ID

        EncryptedReputationData storage data = userReputationData[ctx.batchId][msg.sender]; // msg.sender is the user who requested the update
        if (!data.governanceVotesEnc.isInitialized()) revert DecryptionFailed(); // Ensure data still exists

        euint32 memory reputationScoreEnc = data.governanceVotesEnc.add(data.positiveReviewsEnc)
            .add(data.negativeReviewsEnc) // totalInteractionsEnc
            .sub(data.negativeReviewsEnc) // positiveInteractionsEnc
            .mul(FHE.asEuint32(100))
            .div(data.governanceVotesEnc.add(data.positiveReviewsEnc).add(data.negativeReviewsEnc)); // totalInteractionsEnc

        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = reputationScoreEnc.toBytes32();
        bytes32 currentHash = _hashCiphertexts(currentCts);

        // Security: State verification ensures that the contract's state (specifically, the ciphertexts
        // that were intended for decryption) has not changed since the decryption was requested.
        // This prevents scenarios where an attacker might alter the data after a request is made
        // but before the decryption service processes it, leading to inconsistent or malicious outcomes.
        if (currentHash != ctx.stateHash) revert StateMismatch();

        FHE.checkSignatures(requestId, cleartexts, proof);
        // Security: Proof verification ensures that the cleartexts were indeed decrypted by a
        // valid FHE decryption service recognized by the FHEVM infrastructure, and that the
        // cleartexts correspond to the ciphertexts originally submitted for decryption.
        // This prevents malicious actors from injecting fake cleartext data.

        uint32 reputationScore = abi.decode(cleartexts, (uint32));
        decryptionContexts[requestId].processed = true;
        emit ReputationUpdateCompleted(requestId, ctx.batchId, msg.sender, reputationScore);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage s, uint32 val) internal {
        if (!s.isInitialized()) {
            s = FHE.asEuint32(val);
        }
    }

    function _requireInitialized(euint32 storage s) internal view {
        if (!s.isInitialized()) {
            revert DecryptionFailed();
        }
    }
}