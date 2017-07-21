/**
 * Created by igorgo on 05.07.2017.
 */
const fs = require('fs-extra'),
    iconv = require('iconv-lite'),
    pd = require('pretty-data2').pd,
    inquirer = require('inquirer'),
    crypto = require('crypto')

let ui = new inquirer.ui.BottomBar()

class Utils {
    static async saveClob1251Xml(xml, path, filename) {
        fs.ensureDirSync(path)
        let content = pd.xml(xml)
        content = content.replace('<![CDATA[\n      <?xml', '<![CDATA[<?xml')
        content = iconv.encode(content,'win1251')
        await fs.writeFile(`${path}/${filename}`, content)
    }

    static async saveClob1251(clob, path, filename) {
        fs.ensureDirSync(path)
        await fs.writeFile(`${path}/${filename}`, iconv.encode(clob, 'win1251'))
    }

    static async saveTextFile(clob, path, filename) {
        fs.ensureDirSync(path)
        await fs.writeFile(`${path}/${filename}`, clob)
    }


    static saveBlob(lob, path, filename, ) {
        return new Promise ((resolve, reject) => {
            lob.on('error', reject)
            lob.on('end', () => {
            })
            lob.on('close', resolve)
            fs.ensureDirSync(path)
            let outStream = fs.createWriteStream(`${path}/${filename}`)
            outStream.on('error', (err) => {
                throw err
            })
            lob.pipe(outStream)
        })
    }

    static conU(message) {
        ui.updateBottomBar(message)
        // conU(message)
    }

    static con(message) {
        // process.stdout.write(message)
        ui.writeLog(message)
    }

    static conE(message) {
        //process.stdout.write(message + '\n')
        ui.writeLog(message + '\n')
    }

    static coalesce(...values) {
        for (let i = 0; i < values.length; i++) {
            if (values[i] !== null && values[i] !== undefined) {
                return values[i]
            }
        }
        return null
    }

    //noinspection JSUnusedGlobalSymbols
    static sanitizeFilename(filename) {
        return filename.replace(/[|&;$%@":/<>()+,]/g, '_')
    }

    static hashFormName(formName) {
        return crypto.createHash('md5').update(formName).digest('hex')
    }

    //noinspection JSUnusedGlobalSymbols
    static fixNum(n) {
        return n ? n.toFixed(0) : null
    }
}

module.exports = Utils