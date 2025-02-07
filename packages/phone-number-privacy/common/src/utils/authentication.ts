import { hexToBuffer, retryAsyncWithBackOffAndTimeout } from '@celo/base'
import { ContractKit } from '@celo/contractkit'
import { AccountsWrapper } from '@celo/contractkit/lib/wrappers/Accounts'
import { AttestationsWrapper } from '@celo/contractkit/lib/wrappers/Attestations'
import { trimLeading0x } from '@celo/utils/lib/address'
import { verifySignature } from '@celo/utils/lib/signatureUtils'
import Logger from 'bunyan'
import crypto from 'crypto'
import { Request } from 'express'
import { fetchEnv, rootLogger } from '..'
import {
  AuthenticationMethod,
  ErrorMessage,
  ErrorType,
  PhoneNumberPrivacyRequest,
} from '../interfaces'
import { FULL_NODE_TIMEOUT_IN_MS, RETRY_COUNT, RETRY_DELAY_IN_MS } from './constants'

import opentelemetry, { SpanStatusCode } from '@opentelemetry/api'
const tracer = opentelemetry.trace.getTracer('signer-tracer')

/*
 * Confirms that user is who they say they are and throws error on failure to confirm.
 * Authorization header should contain the EC signed body
 */
export async function authenticateUser<R extends PhoneNumberPrivacyRequest>(
  request: Request<{}, {}, R>,
  contractKit: ContractKit,
  logger: Logger,
  shouldFailOpen: boolean = false,
  warnings: ErrorType[] = [],
  timeoutMs: number = FULL_NODE_TIMEOUT_IN_MS,
  retryCount: number = RETRY_COUNT,
  retryDelay: number = RETRY_DELAY_IN_MS
): Promise<boolean> {
  return tracer.startActiveSpan('Authentication - authenticateUser', async (span) => {
    logger.debug('Authenticating user')
    span.addEvent('Authenticating user')

    // https://tools.ietf.org/html/rfc7235#section-4.2
    const messageSignature = request.get('Authorization')
    const message = JSON.stringify(request.body)
    const signer = request.body.account
    const authMethod = request.body.authenticationMethod

    if (!messageSignature || !signer) {
      span.addEvent('No messageSignature or signer')
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'No messageSignature or signer',
      })
      span.end()
      return false
    }

    if (authMethod && authMethod === AuthenticationMethod.ENCRYPTION_KEY) {
      span.addEvent('Authenticating user with encryption key')
      let registeredEncryptionKey
      try {
        span.addEvent('Getting data emcryption key')
        registeredEncryptionKey = await getDataEncryptionKey(
          signer,
          contractKit,
          logger,
          timeoutMs,
          retryCount,
          retryDelay
        )
      } catch (err) {
        // getDataEncryptionKey should only throw if there is a full-node connection issue.
        // That is, it does not throw if the DEK is undefined or invalid
        const failureStatus = shouldFailOpen
          ? ErrorMessage.FAILING_OPEN
          : ErrorMessage.FAILING_CLOSED
        logger.error({
          err,
          warning: ErrorMessage.FAILURE_TO_GET_DEK,
          failureStatus,
        })
        warnings.push(ErrorMessage.FAILURE_TO_GET_DEK, failureStatus)
        span.addEvent('Error with full-node connection issue')
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: ErrorMessage.FAILURE_TO_GET_DEK + failureStatus,
        })
        span.end()
        return shouldFailOpen
      }
      if (!registeredEncryptionKey) {
        logger.warn({ account: signer }, 'Account does not have registered encryption key')
        span.addEvent('Account does not have registered encryption key')
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'Account does not have registered encryption key',
        })
        span.end()
        return false
      } else {
        span.addEvent('Verifying with DEK')
        logger.info({ dek: registeredEncryptionKey, account: signer }, 'Found DEK for account')
        if (verifyDEKSignature(message, messageSignature, registeredEncryptionKey, logger)) {
          span.addEvent('DEK verification OK')
          span.setStatus({
            code: SpanStatusCode.OK,
            message: 'DEK verifycation OK',
          })
          span.end()
          return true
        }
      }
    }

    // Fallback to previous signing pattern
    logger.info(
      { account: signer, message, messageSignature },
      'Message was not authenticated with DEK, attempting to authenticate using wallet key'
    )
    // TODO This uses signature utils, why doesn't DEK authentication?
    // (https://github.com/celo-org/celo-monorepo/issues/9803)
    span.addEvent('Verifying with wallet key')
    span.end()
    return verifySignature(message, messageSignature, signer)
  })
}

export function getMessageDigest(message: string) {
  // NOTE: Elliptic will truncate the raw msg to 64 bytes before signing,
  // so make sure to always pass the hex encoded msgDigest instead.
  return crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

// Used primarily for signing requests with a DEK, counterpart of verifyDEKSignature
// For general signing, use SignatureUtils in @celo/utils
export function signWithRawKey(msg: string, rawKey: string) {
  // NOTE: elliptic is disabled elsewhere in this library to prevent
  // accidental signing of truncated messages.
  // tslint:disable-next-line:import-blacklist
  const EC = require('elliptic').ec
  const ec = new EC('secp256k1')

  // Sign
  const key = ec.keyFromPrivate(hexToBuffer(rawKey))
  return JSON.stringify(key.sign(getMessageDigest(msg)).toDER())
}

export function verifyDEKSignature(
  message: string,
  messageSignature: string,
  registeredEncryptionKey: string,
  logger?: Logger
) {
  logger = logger ?? rootLogger(fetchEnv('SERVICE_NAME'))
  try {
    // NOTE: elliptic is disabled elsewhere in this library to prevent
    // accidental signing of truncated messages.
    // tslint:disable-next-line:import-blacklist
    const EC = require('elliptic').ec
    const ec = new EC('secp256k1')
    const key = ec.keyFromPublic(trimLeading0x(registeredEncryptionKey), 'hex')
    const parsedSig = JSON.parse(messageSignature)
    // TODO why do we use a different signing method instead of SignatureUtils?
    // (https://github.com/celo-org/celo-monorepo/issues/9803)
    if (key.verify(getMessageDigest(message), parsedSig)) {
      return true
    }
    return false
  } catch (err) {
    logger.error('Failed to verify signature with DEK')
    logger.error({ err, dek: registeredEncryptionKey })
    return false
  }
}

export async function getDataEncryptionKey(
  address: string,
  contractKit: ContractKit,
  logger: Logger,
  fullNodeTimeoutMs: number,
  fullNodeRetryCount: number,
  fullNodeRetryDelayMs: number
): Promise<string> {
  try {
    const res = await retryAsyncWithBackOffAndTimeout(
      async () => {
        const accountWrapper: AccountsWrapper = await contractKit.contracts.getAccounts()
        return accountWrapper.getDataEncryptionKey(address)
      },
      fullNodeRetryCount,
      [],
      fullNodeRetryDelayMs,
      1.5,
      fullNodeTimeoutMs
    )
    return res
  } catch (error) {
    logger.error('Failed to retrieve DEK: ' + error)
    logger.error(ErrorMessage.FULL_NODE_ERROR)
    throw error
  }
}

export async function isVerified(
  account: string,
  hashedPhoneNumber: string,
  contractKit: ContractKit,
  logger: Logger
): Promise<boolean> {
  try {
    const res = await retryAsyncWithBackOffAndTimeout(
      async () => {
        const attestationsWrapper: AttestationsWrapper =
          await contractKit.contracts.getAttestations()
        const {
          isVerified: _isVerified,
          completed,
          numAttestationsRemaining,
          total,
        } = await attestationsWrapper.getVerifiedStatus(hashedPhoneNumber, account)

        logger.debug({
          account,
          isVerified: _isVerified,
          completedAttestations: completed,
          remainingAttestations: numAttestationsRemaining,
          totalAttestationsRequested: total,
        })
        return _isVerified
      },
      RETRY_COUNT,
      [],
      RETRY_DELAY_IN_MS,
      1.5,
      FULL_NODE_TIMEOUT_IN_MS
    )
    return res
  } catch (error) {
    logger.error('Failed to get verification status: ' + error)
    logger.error(ErrorMessage.FULL_NODE_ERROR)
    logger.warn('Assuming user is verified')
    return true
  }
}
