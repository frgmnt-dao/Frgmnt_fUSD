

## Hardhat Configuration

- [Typechain](https://github.com/dethcrypto/TypeChain) plugin enabled (typescript type bindings for smart contracts)
- [Ignition](https://hardhat.org/ignition/docs/getting-started) for contract deployment
- Testing environment configured and operational, with test coverage
- Prettier and eslint configured for project files and solidity smart contract
- [Solhint](https://github.com/protofire/solhint) configured for enforcing best practices
- Github actions workflows prepared for CI/CD
Check the Hardhat documentation for more information.

https://hardhat.org/getting-started/


## Hardhat Shorthand

We recommend installing `hh autocomplete` so you can use `hh` shorthand globally.

```shell
npm i -g hardhat-shorthand
```

https://hardhat.org/guides/shorthand.html

### Common Shorthand Commands

- `hh compile` - to compile smart contract and generate typechain ts bindings
- `hh test` - to run tests
- `hh igntion` - to deploy smart contracts
- `hh node` - to run a localhost node
- `hh help` - to see all available commands
- `hh TABTAB` - to use autocomplete

## Usage

### Setup

#### 1. Install Dependencies

```shell
npm install
```

#### 2. Compile Contracts

```shell
npm run compile
```

#### 3. Environment Setup

Create `.env` file and add your environment variables. You can use `.env.example` as a template.

If you are going to use public network, make sure you include the right RPC provider for that network.

Make sure you include either `MNEMONIC` or `PRIVATE_KEY` in your `.env` file.

#### Deploy Contract

```shell
hh ignition deploy ignition/modules/BasicERC721Module.ts --network sepolia
```

**Verify contract**

```shell
hh ignition verify chain-11155111
```

### Testing

#### Run Tests

```shell
npm run test
```

#### Run Coverage

```shell
npm run coverage
```

---

### Project Hygiene

#### Prettier - Non Solidity Files

```shell
npm run format:check
npm run format:write
```

#### Lint - Non Solidity Files

```shell
npm run lint:check
npm run lint:fix
```

#### Prettier - Solidity

```shell
npm run sol:format:check
npm run sol:format:write
```

#### Solhint - Enforcing styles and security best practices

```shell
npm run solhint
```


Head over to [protokol.com/careers](https://www.protokol.com/careers/) to discover the roles we have available or to submit your résumé.
