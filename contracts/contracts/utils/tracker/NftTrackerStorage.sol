// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ---------------------------------------------------------------------------
 *  Project: Frgmnt
 *  Contract: NftTrackerStorage
 *  Description:
 *     This storage contract is used by Frgmnt-compatible Guard contracts to
 *     track NFT-based positions for each pool. It supports generic bytes data
 *     as well as uint256 NFT IDs for use-cases such as:
 *        - tracking open lending positions
 *        - tracking protocol-specific NFT receipts
 *        - managing slot-based positions with max capacity
 *
 *     Only authorized guards (validated through poolFactory) are allowed to
 *     add or remove NFT tracking entries. The Owner (governance) retains
 *     override functions for maintenance.
 * ---------------------------------------------------------------------------
 */

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "../../interfaces/IHasGuardInfo.sol";

contract NftTrackerStorage is OwnableUpgradeable {
    // -------------------------------------------------------------------------
    //                               STORAGE
    // -------------------------------------------------------------------------

    /// @notice Address of the dHEDGE / Frgmnt pool factory used to validate guards
    address public poolFactory;

    /// @notice NFT tracking data:
    ///  _nftTrackData[_nftType][_pool] = array of encoded bytes entries
    ///  where:
    ///    - _nftType is keccak256 hash of NFT_TYPE
    ///    - _pool is the poolLogic address
    mapping(bytes32 => mapping(address => bytes[])) internal _nftTrackData;

    // -------------------------------------------------------------------------
    //                              INITIALIZER
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract with the poolFactory address
     * @dev Uses OpenZeppelin OwnableUpgradeable initializer (OZ v5 style)
     * @param _poolFactory Address of the pool factory (dHEDGE / Frgmnt factory)
     */
    function initialize(address _poolFactory) external initializer {
        require(_poolFactory != address(0), "NftTrackerStorage: poolFactory=0");
        __Ownable_init(msg.sender); // OZ v5 requires initialOwner param
        poolFactory = _poolFactory;
    }

    // -------------------------------------------------------------------------
    //                          OWNER CONFIGURATION
    // -------------------------------------------------------------------------

    event PoolFactorySet(address indexed oldPoolFactory, address indexed newPoolFactory);

    /**
     * @notice Corrects the poolFactory address post-deploy.
     * @dev Auditor-flagged (CertiK): deploy_contract_guard.ts previously passed PoolLogic's
     *      address here instead of PoolManagerLogic's — poolFactory must implement
     *      getContractGuard(), which only PoolManagerLogic does, or checkContractGuard()
     *      permanently reverts for every guard, exactly as it did before this fix. No
     *      addData/removeData/addUintId/removeUintId call could ever have succeeded under
     *      the wrong address (checkContractGuard reverts before any state write), so
     *      correcting this cannot orphan or overwrite any previously tracked position data.
     */
    function setPoolFactory(address _poolFactory) external onlyOwner {
        require(_poolFactory != address(0), "NftTrackerStorage: poolFactory=0");
        emit PoolFactorySet(poolFactory, _poolFactory);
        poolFactory = _poolFactory;
    }

    // -------------------------------------------------------------------------
    //                             MODIFIERS
    // -------------------------------------------------------------------------

    /**
     * @notice Ensures that the caller is the correct guard for `_guardedContract`
     * @param _guardedContract Address of the contract guarded (e.g. poolLogic or strategy)
     */
    modifier checkContractGuard(address _guardedContract) {
        require(
            IHasGuardInfo(poolFactory).getContractGuard(_guardedContract) == msg.sender,
            "not correct contract guard"
        );
        _;
    }

    // -------------------------------------------------------------------------
    //                       INTERNAL STORAGE MANAGEMENT
    // -------------------------------------------------------------------------

    /**
     * @notice Internal function to record new NFT data
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @param _data the nft track data to be recorded in storage
     */
    function _addData(bytes32 _nftType, address _pool, bytes memory _data) private {
        _nftTrackData[_nftType][_pool].push(_data);
    }

    /**
     * @notice Internal function to delete NFT data by index using swap-and-pop
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @param _index the nft track data index to be removed from storage
     */
    function _removeData(bytes32 _nftType, address _pool, uint256 _index) private {
        uint256 length = _nftTrackData[_nftType][_pool].length;
        require(_index < length, "invalid index");

        // Swap the element to remove with the last one then pop
        _nftTrackData[_nftType][_pool][_index] = _nftTrackData[_nftType][_pool][length - 1];
        _nftTrackData[_nftType][_pool].pop();
    }

    // -------------------------------------------------------------------------
    //                      EXTERNAL GUARD FUNCTIONS
    // -------------------------------------------------------------------------

    /**
     * @notice Record new NFT data
     * @dev Only called by authorized guard
     * @param _guardedContract the address of contract using nftStorage
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @param _data the nft track data to be recorded in storage
     */
    function addData(
        address _guardedContract,
        bytes32 _nftType,
        address _pool,
        bytes memory _data
    ) external checkContractGuard(_guardedContract) {
        _addData(_nftType, _pool, _data);
    }

    /**
     * @notice Delete NFT data
     * @dev Only called by authorized guard
     * @param _guardedContract the address of contract using nftStorage
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @param _index the nft track data index to be removed from storage
     */
    function removeData(
        address _guardedContract,
        bytes32 _nftType,
        address _pool,
        uint256 _index
    ) external checkContractGuard(_guardedContract) {
        _removeData(_nftType, _pool, _index);
    }

    /**
     * @notice Record new NFT uint256 id
     * @dev Only called by authorized guard, enforces max positions
     * @param _guardedContract the address of contract using nftStorage
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @param _nftID the nft id recorded in storage
     * @param _maxPositions maximum allowed tracked positions for this NFT_TYPE & pool
     */
    function addUintId(
        address _guardedContract,
        bytes32 _nftType,
        address _pool,
        uint256 _nftID,
        uint256 _maxPositions
    ) external checkContractGuard(_guardedContract) {
        _addData(_nftType, _pool, abi.encode(_nftID));
        require(getDataCount(_nftType, _pool) <= _maxPositions, "max position reached");
    }

    /**
     * @notice Remove NFT uint256 id
     * @dev Only called by authorized guard, iterates to find the ID
     * @param _guardedContract the address of contract using nftStorage
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @param _nftID the nft id recorded in storage
     */
    function removeUintId(
        address _guardedContract,
        bytes32 _nftType,
        address _pool,
        uint256 _nftID
    ) external checkContractGuard(_guardedContract) {
        bytes[] memory data = getAllData(_nftType, _pool);
        for (uint256 i = 0; i < data.length; i++) {
            if (abi.decode(data[i], (uint256)) == _nftID) {
                _removeData(_nftType, _pool, i);
                return;
            }
        }

        revert("not found");
    }

    // -------------------------------------------------------------------------
    //                   OWNER-ONLY MAINTENANCE FUNCTIONS
    // -------------------------------------------------------------------------

    /**
     * @notice Remove NFT data by uint256 ID (owner override)
     */
    function removeDataByUintId(
        bytes32 _nftType,
        address _pool,
        uint256 _nftID
    ) external onlyOwner {
        bytes[] memory data = getAllData(_nftType, _pool);
        for (uint256 i = 0; i < data.length; i++) {
            if (abi.decode(data[i], (uint256)) == _nftID) {
                _removeData(_nftType, _pool, i);
                return;
            }
        }
        revert("not found");
    }

    /**
     * @notice Remove NFT data by index (owner override)
     */
    function removeDataByIndex(bytes32 _nftType, address _pool, uint256 _index) external onlyOwner {
        _removeData(_nftType, _pool, _index);
    }

    /**
     * @notice Add NFT data by uint256 ID (owner override)
     */
    function addDataByUintId(bytes32 _nftType, address _pool, uint256 _nftID) external onlyOwner {
        _addData(_nftType, _pool, abi.encode(_nftID));
    }

    // -------------------------------------------------------------------------
    //                           VIEW FUNCTIONS
    // -------------------------------------------------------------------------

    /**
     * @notice Returns tracked nft by index
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @param _index the index of nft track data
     * @return data the nft track data of given NFT_TYPE & poolLogic & index
     */
    function getData(
        bytes32 _nftType,
        address _pool,
        uint256 _index
    ) external view returns (bytes memory) {
        return _nftTrackData[_nftType][_pool][_index];
    }

    /**
     * @notice Returns all tracked nfts by NFT_TYPE & poolLogic
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @return data all tracked nfts of given NFT_TYPE & poolLogic
     */
    function getAllData(bytes32 _nftType, address _pool) public view returns (bytes[] memory) {
        return _nftTrackData[_nftType][_pool];
    }

    /**
     * @notice Returns all tracked nfts count by NFT_TYPE & poolLogic
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @return count all tracked nfts count of given NFT_TYPE & poolLogic
     */
    function getDataCount(bytes32 _nftType, address _pool) public view returns (uint256) {
        return _nftTrackData[_nftType][_pool].length;
    }

    /**
     * @notice Returns all tracked nft ids by NFT_TYPE & poolLogic if stored as uint256
     * @param _nftType keccak of NFT_TYPE
     * @param _pool the poolLogic address
     * @return tokenIds all tracked nfts of given NFT_TYPE & poolLogic
     */
    function getAllUintIds(
        bytes32 _nftType,
        address _pool
    ) public view returns (uint256[] memory tokenIds) {
        bytes[] memory data = getAllData(_nftType, _pool);
        tokenIds = new uint256[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            tokenIds[i] = abi.decode(data[i], (uint256));
        }
    }
}
