/**
 * The application's decision layer, independent of the DOM.
 *
 * It holds the loaded state, decides which actions each milestone and outflow
 * offers, and sends exactly the call the contract expects. The UI renders
 * what this returns; tests drive it directly.
 */

import {
  availableActions,
  isProjectScoped,
  roleOf,
  writesEnabled,
} from "./actions.js";
import { readMilestone, readOutflows, readProject, sendAction } from "./escrow.js";
import { buildCall } from "./methods.js";
import { milestonePredicates, outflowActions, projectPredicates } from "./predicates.js";
import { describeMismatch, networkMatches } from "./network.js";
import { EXPECTED_INTERFACE_ID } from "./config.js";
import { TX_IDLE } from "./tx.js";

export function createController({ config, networkInfo }) {
  const state = {
    client: null,
    account: null,
    chainId: null,
    project: null,
    milestones: [],
    outflows: [],
    now: 0,
    needsReconnect: false,
    txState: TX_IDLE,
    lastError: null,
  };

  const api = {
    state,

    setWallet({ client, account, chainId }) {
      state.client = client || null;
      state.account = account || null;
      state.chainId = chainId === undefined ? state.chainId : chainId;
      state.needsReconnect = false;
    },

    setChainId(chainId) {
      state.chainId = chainId;
    },

    /**
     * Handle a wallet account change.
     *
     * The SDK client is bound to the account it was created with, so keeping
     * it after a switch would let the UI show one account while transactions
     * were signed by another. The client is therefore discarded and writes
     * stay disabled until the user reconnects explicitly.
     */
    setAccount(account) {
      const changed =
        String(account || "").toLowerCase() !==
        String(state.account || "").toLowerCase();

      state.account = account || null;

      if (changed) {
        state.client = null;
        state.needsReconnect = Boolean(account);
      }
    },

    get correctNetwork() {
      return networkMatches(state.chainId, networkInfo.chainId);
    },

    get interfaceSupported() {
      // Fail closed: an unread contract is not a supported one. Writes stay
      // disabled until the contract has actually reported the expected id,
      // so a refresh that never ran or failed cannot leave the app sending
      // calls built for an interface it has not confirmed.
      return (
        Boolean(state.project) &&
        state.project.interfaceId === EXPECTED_INTERFACE_ID
      );
    },

    get interfaceWarning() {
      if (api.interfaceSupported) return null;

      if (!state.project) {
        return (
          "The contract has not been read yet, so its interface is " +
          "unconfirmed and actions are disabled."
        );
      }

      return (
        `This contract reports interface ${state.project.interfaceId}, but ` +
        `this app is built for ${EXPECTED_INTERFACE_ID}. Actions are ` +
        "disabled because the calls would not match."
      );
    },

    get writesEnabled() {
      return (
        writesEnabled({
          configOk: config.ok,
          connected: Boolean(state.account && state.client),
          correctNetwork: api.correctNetwork,
        }) && api.interfaceSupported
      );
    },

    get reconnectWarning() {
      return state.needsReconnect
        ? "The wallet switched accounts. Reconnect to sign as " +
            `${state.account}; the previous session cannot sign for it.`
        : null;
    },

    get networkWarning() {
      if (!state.account) return null;

      return api.correctNetwork
        ? null
        : describeMismatch(state.chainId, networkInfo);
    },

    /** Load everything the UI and the predicates need. */
    async refresh(readClient, now) {
      const client = state.client || readClient;

      if (!config.ok || !client) return state;

      const project = await readProject(client, config.escrowAddress);
      const count = Math.min(project.milestoneCount, 20);

      const milestones = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          readMilestone(client, config.escrowAddress, i),
        ),
      );

      const outflows = await readOutflows(
        client,
        config.escrowAddress,
        project.outflowCount,
      );

      const activeIndex = milestones.findIndex(
        (m) =>
          m.status !== "LOCKED" &&
          m.status !== "RELEASED" &&
          m.status !== "REFUNDED" &&
          m.status !== "CANCELLED",
      );

      state.now = now;
      state.outflows = outflowActions(outflows, state.account);
      state.project = projectPredicates(project, outflows, state.account);
      state.milestones = milestones.map((m) =>
        milestonePredicates(m, now, activeIndex),
      );

      return state;
    },

    role() {
      return roleOf(state.account, state.project);
    },

    /**
     * Project-wide actions, computed once. Funding, settlement, outflow
     * handling, sweeping and closing belong to the project, so repeating them
     * under every milestone would be noise and would suggest they differ per
     * milestone.
     */
    projectActions() {
      return availableActions({
        role: api.role(),
        project: state.project,
        milestone: null,
      }).filter((entry) => isProjectScoped(entry.action));
    },

    /** Actions per milestone, so every milestone is actionable, not just #0. */
    actionsByMilestone() {
      const role = api.role();

      return state.milestones.map((milestone) => ({
        milestoneIndex: milestone.index,
        status: milestone.status,
        actions: availableActions({
          role,
          project: state.project,
          milestone,
        }).filter((entry) => !isProjectScoped(entry.action)),
      }));
    },

    /** Outflow rows with their permitted actions and ownership reasons. */
    outflowRows() {
      return state.outflows.map((outflow) => ({
        ...outflow,
        actions: [
          ...(outflow.confirmable ? ["confirm_outflow"] : []),
          ...(outflow.redirectable ? ["redirect_outflow"] : []),
        ],
      }));
    },

    /** Inputs the contract supplies rather than the user. */
    implicitInput(action, { outflowId } = {}) {
      if (action === "accept_settlement") {
        return { nonce: state.project.settlement.nonce };
      }

      if (action === "confirm_outflow" || action === "redirect_outflow") {
        return { outflow_id: outflowId };
      }

      return {};
    },

    async dispatch(action, { milestoneIndex = 0, input = {}, outflowId } = {}) {
      if (!api.writesEnabled) {
        // Most specific cause first, so the message names the thing the user
        // can actually act on.
        if (!config.ok) {
          throw new Error(
            "Writes are disabled: no deployed escrow is configured.",
          );
        }

        throw new Error(
          api.reconnectWarning ||
            api.networkWarning ||
            api.interfaceWarning ||
            "Writes are disabled: connect a wallet.",
        );
      }

      const call = buildCall(action, {
        milestoneIndex,
        input: { ...api.implicitInput(action, { outflowId }), ...input },
      });

      return sendAction(
        state.client,
        { address: config.escrowAddress, ...call },
        (txState) => {
          state.txState = txState;
        },
      );
    },
  };

  return api;
}
