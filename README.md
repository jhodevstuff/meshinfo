# meshinfo [Server]
##### This is the server part of the project, which connects to a Meshtastic node and retrieves data (and uploads it to the web server).
> **Note:** The frontend relies on data provided by this backend.

Click [here](https://github.com/jhodevstuff/meshinfo-fe) for the frontend part (visualizing node data).

### How the Node.js Script Works

The script runs in an infinite loop where it retrieves data using the Meshtastic Python CLI (`--info`) and executes traceroutes (`--traceroute`). These can then be uploaded to the web server using the PHP API, where the [frontend](https://github.com/jhodevstuff/meshinfo-fe) is hosted and visualizes this data.

### Data Collected by the Node.js Script

- **Node Information:**
  - ID, Long Name, Short Name, Hardware Model
  - Location data (Latitude, Longitude)

- **Power Data:**
  - Battery Level
  - Voltage

- **Network Status:**
  - Signal-to-Noise Ratio (SNR)
  - Number of Hops
  - Online Status with Timestamps

- **Traceroute Data:**
  - Paths to and from each node
  - Number of Hops

- **Timestamps:**
  - Last Update
  - Last Heard Time


### Explanation of the Components

- `meshinfo.js`  
  Collects data (`--info`, `--traceroute`) and stores it in a JSON file (`meshdata.json`). It also deletes old data (configurable) and sends the current dataset to the API on the web server. Will run indefinitely.

- `updatelog.php`  
  This is the API hosted on the web server that accepts and stores the data. Multiple master nodes can communicate with this API and store their data there.

- `config.json`  
  Used to configure `meshinfo.js`. Here you set important parameters, such as delays, whether the node board is connected via a serial interface or through the computer's local network, when old data is deleted, API key, absolute Meshtastic path (required for some Linux installations).

### Installation & Setup
**Prerequisite:** Ensure that you have a current version of Node.js & NPM installed! There may be problems if this is not the case. Check your version with `node -v`, I recommend version 20 or newer.

Before proceeding, install the [Meshtastic CLI](https://meshtastic.org/docs/software/python/cli/installation/?install-python-cli=linux) and test it!

1. Clone the repository:  
   `git clone https://github.com/jhodevstuff/meshinfo.git`
2. Go into the directory:  
   `cd meshinfo`
3. Install the Node modules:  
   `npm install`
4. Prepare the config:  
   `cp example.config.json config.json`
5. Adjust `config.json`:
   - Insert the absolute Meshtastic CLI path (`which meshtastic`), this might be important for some Linux installations.
   - Adjust whether you want to use a node over the network (IP address). If not, the node will be used via USB serial interface.
   - Enter the API key that you set in the `updatelog.php` server script (if you want to upload it to the web server), as well as the URL to the PHP script on your web server.
   - The `isRaspberryPi` parameter uses the absolute Meshtastic path, as otherwise, there may be problems; just try it.
   - Adjust when you want old data to be deleted (you can leave the default values).
   - Adjust the delays (you can leave the default values).
6. Run the script:  
   `node meshinfo`

Now you should see that it is doing something.

**Example**:
```
jho@Brunhilde meshinfo % node meshinfo
[2024-12-22_22:35:41] Loading Nodes infos
[2024-12-22_22:35:50] Data updated
[2024-12-22_22:35:50] Updated data on server
[2024-12-22_22:35:50] Traceroute to Node !6458fccb
[2024-12-22_22:36:00] Data updated
[2024-12-22_22:36:00] Updated data on server
```

#### Running Permanently
If you want to run the script on a Raspberry Pi so that it always retrieves and updates the data, I recommend doing it with a crontab. Here you should also find and note the absolute node path beforehand (`which node`).

Edit crontab:  
`crontab -e`

Add this line and adjust your absolute node path and the meshinfo directory path:

```
@reboot /home/jho/.nvm/versions/node/v21.6.2/bin/node /home/jho/meshinfo/meshinfo.js >> /home/jho/meshinfo/crontab.log 2>&1
```

Now you can restart the computer and the script should automatically run permanently. If it does not, you can check the log file specified in the above line to see where the problem is.

### Things I Noticed
- Unfortunately, it is not so easy to retrieve telemetry data, as these are not specified with `--info`.
- Possibly, the connection via USB with the node is more reliable than over the network.

###### Joshua Hoffmann / 2024-12-22
