export default defineBackground(() => {
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  browser.runtime.onConnect.addListener(port => {
    if (port.name === "twice-reader") port.onDisconnect.addListener(() => {});
  });
});
