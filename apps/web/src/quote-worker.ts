import 'utils/workerPolyfill'
import { SmartRouter } from '@pancakeswap/smart-router/evm'
import { Call } from 'state/multicall/actions'
import { fetchChunk } from 'state/multicall/fetchChunk'
import { createViemPublicClientGetter } from 'utils/viem'
import { getLogger } from 'utils/datadog'

const { parseCurrency, parseCurrencyAmount, parsePool, serializeTrade } = SmartRouter.Transformer

export type WorkerGetBestTradeEvent = [
  id: number,
  message: {
    cmd: 'getBestTrade'
    params: SmartRouter.APISchema.RouterPostParams
  },
]

const fetch_ = fetch
const logger = getLogger('quote-rpc', { forwardErrorsToLogs: false })

const fetchWithLogging = async (url: RequestInfo | URL, init?: RequestInit) => {
  const start = Date.now()
  let urlString: string | undefined
  let size: number | undefined
  if (init && init.method === 'POST' && init.body) {
    urlString = url.toString()
    size = init.body.toString().length / 1024
  }

  const response = await fetch_(url, init)
  const end = Date.now()
  if (urlString && size) {
    if (!urlString.includes('datadoghq.com')) {
      try {
        logger.info('Quote RPC', {
          rpc: {
            duration: end - start,
            url: urlString,
            size,
            status: response.status,
          },
        })
      } catch (e) {
        console.error(e)
      }
    }
  }

  return response
}

globalThis.fetch = fetchWithLogging

export type WorkerMultiChunkEvent = [
  id: number,
  message: {
    cmd: 'multicallChunk'
    params: {
      chainId: number
      chunk: Call[]
      minBlockNumber: number
    }
  },
]

export type WorkerEvent = WorkerGetBestTradeEvent | WorkerMultiChunkEvent

// Assume the worker is single threaded
// If there're multiple get best trade requests, should create multiple worker instances
// let getBestTradeAbortController: AbortController | undefined

// eslint-disable-next-line no-restricted-globals
addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
  const { data } = event
  const [id, message] = data
  if (message.cmd === 'multicallChunk') {
    fetchChunk(message.params.chainId, message.params.chunk, message.params.minBlockNumber)
      .then((res) => {
        postMessage([
          id,
          {
            success: true,
            result: res,
          },
        ])
      })
      .catch((err) => {
        postMessage([
          id,
          {
            success: false,
            error: err,
          },
        ])
      })
  }
  if (message.cmd === 'getBestTrade') {
    const parsed = SmartRouter.APISchema.zRouterPostParams.safeParse(message.params)
    if (parsed.success === false) {
      postMessage([
        id,
        {
          success: false,
          error: parsed.error.message,
        },
      ])
      return
    }
    // getBestTradeAbortController?.abort()
    // getBestTradeAbortController = new AbortController()

    const {
      amount,
      chainId,
      currency,
      tradeType,
      blockNumber,
      gasPriceWei,
      maxHops,
      maxSplits,
      poolTypes,
      candidatePools,
      onChainQuoterGasLimit: gasLimit,
      nativeCurrencyUsdPrice,
      quoteCurrencyUsdPrice,
    } = parsed.data
    // const onChainProvider = createViemPublicClientGetter({ transportSignal: getBestTradeAbortController.signal })
    const onChainProvider = createViemPublicClientGetter()
    const onChainQuoteProvider = SmartRouter.createQuoteProvider({ onChainProvider, gasLimit })
    const currencyAAmount = parseCurrencyAmount(chainId, amount)
    const currencyB = parseCurrency(chainId, currency)

    const pools = candidatePools.map((pool) => parsePool(chainId, pool as any))

    const gasPrice = gasPriceWei
      ? BigInt(gasPriceWei)
      : async () => BigInt((await onChainProvider({ chainId }).getGasPrice()).toString())

    SmartRouter.getBestTrade(currencyAAmount, currencyB, tradeType, {
      gasPriceWei: gasPrice,
      poolProvider: SmartRouter.createStaticPoolProvider(pools),
      quoteProvider: onChainQuoteProvider,
      maxHops,
      maxSplits,
      blockNumber: blockNumber ? Number(blockNumber) : undefined,
      allowedPoolTypes: poolTypes,
      quoterOptimization: false,
      quoteCurrencyUsdPrice,
      nativeCurrencyUsdPrice,
      // signal: getBestTradeAbortController.signal,
    })
      .then((res) => {
        postMessage([
          id,
          {
            success: true,
            result: res && serializeTrade(res),
          },
        ])
      })
      .catch((err) => {
        postMessage([
          id,
          {
            success: false,
            error: err.message,
          },
        ])
      })
  }
})
